package dlr

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"

	"smsgw/engine/internal/cdr"
	"smsgw/engine/internal/metrics"
	"smsgw/engine/internal/phone"
	"smsgw/engine/internal/pipeline"
	"smsgw/engine/internal/smpp/pdu"
	"smsgw/engine/internal/store"
	"smsgw/engine/internal/webhook"
)

// SMPPDeliverer pushes a deliver_sm to a bound client session
// (*server.Server).
type SMPPDeliverer interface {
	Deliver(ctx context.Context, systemID string, d *pdu.DeliverSM) (*pdu.DeliverSMResp, error)
}

// WebhookQueue enqueues webhook deliveries (*webhook.Queue).
type WebhookQueue interface {
	Enqueue(ctx context.Context, d webhook.Delivery) error
}

// Snapshotter is *store.Store.
type Snapshotter interface {
	Current() *store.Snapshot
}

// ForwarderOptions tune a Forwarder.
type ForwarderOptions struct {
	Stream         string        // default pipeline.DLROutStream
	Group          string        // consumer group; default "dlr-out"
	Consumer       string        // consumer name (instance id); default "engine"
	Workers        int           // concurrent events; default 16
	Batch          int           // XREADGROUP count; default 100
	Block          time.Duration // default 1s
	RetryIdle      time.Duration // an unacked event is retried after this; default 30s
	MaxAge         time.Duration // give up delivering to SMPP after; default 72h
	DeliverTimeout time.Duration // deliver_sm_resp wait; default 10s
	Logger         *slog.Logger
	Metrics        *metrics.Engine
	Now            func() time.Time
}

// Forwarder consumes q:dlr-out.
type Forwarder struct {
	rdb  redis.UniversalClient
	src  Snapshotter
	smpp SMPPDeliverer
	wh   WebhookQueue
	opts ForwarderOptions
	log  *slog.Logger
	m    *metrics.Engine

	mu     sync.Mutex
	inproc map[string]struct{}
}

// NewForwarder creates a Forwarder; smpp and wh may be nil.
func NewForwarder(rdb redis.UniversalClient, src Snapshotter, smpp SMPPDeliverer, wh WebhookQueue, o ForwarderOptions) *Forwarder {
	if o.Stream == "" {
		o.Stream = pipeline.DLROutStream
	}
	if o.Group == "" {
		o.Group = "dlr-out"
	}
	if o.Consumer == "" {
		o.Consumer = "engine"
	}
	if o.Workers <= 0 {
		o.Workers = 16
	}
	if o.Batch <= 0 {
		o.Batch = 100
	}
	if o.Block <= 0 {
		o.Block = time.Second
	}
	if o.RetryIdle <= 0 {
		o.RetryIdle = 30 * time.Second
	}
	if o.MaxAge <= 0 {
		o.MaxAge = 72 * time.Hour
	}
	if o.DeliverTimeout <= 0 {
		o.DeliverTimeout = 10 * time.Second
	}
	if o.Logger == nil {
		o.Logger = slog.Default()
	}
	if o.Metrics == nil {
		o.Metrics = metrics.NewEngine(metrics.NewRegistry())
	}
	if o.Now == nil {
		o.Now = time.Now
	}
	return &Forwarder{rdb: rdb, src: src, smpp: smpp, wh: wh, opts: o,
		log: o.Logger.With("component", "dlr-forwarder"), m: o.Metrics, inproc: map[string]struct{}{}}
}

// Run consumes events until ctx is cancelled and waits for in-flight ones.
func (f *Forwarder) Run(ctx context.Context) {
	sem := make(chan struct{}, f.opts.Workers)
	var wg sync.WaitGroup
	defer wg.Wait()
	run := func(id string, values map[string]any) {
		if !f.claim(id) {
			return
		}
		sem <- struct{}{}
		wg.Add(1)
		go func() {
			defer func() { <-sem; wg.Done(); f.release(id) }()
			if f.handle(context.WithoutCancel(ctx), id, values) {
				f.ack(id)
			}
		}()
	}
	groupOK := false
	lastClaim := time.Now()
	for ctx.Err() == nil {
		if !groupOK {
			err := f.rdb.XGroupCreateMkStream(ctx, f.opts.Stream, f.opts.Group, "0").Err()
			if err != nil && !strings.Contains(err.Error(), "BUSYGROUP") {
				if ctx.Err() == nil {
					f.log.Warn("create dlr-out group failed", "err", err)
				}
				sleep(ctx, time.Second)
				continue
			}
			groupOK = true
		}
		if time.Since(lastClaim) >= f.opts.RetryIdle/2 {
			lastClaim = time.Now()
			f.reclaim(ctx, run)
		}
		free := cap(sem) - len(sem)
		if free == 0 {
			sleep(ctx, 20*time.Millisecond)
			continue
		}
		res, err := f.rdb.XReadGroup(ctx, &redis.XReadGroupArgs{
			Group: f.opts.Group, Consumer: f.opts.Consumer, Streams: []string{f.opts.Stream, ">"},
			Count: int64(min(free, f.opts.Batch)), Block: f.opts.Block,
		}).Result()
		if err != nil {
			if errors.Is(err, redis.Nil) || ctx.Err() != nil {
				continue
			}
			if strings.Contains(err.Error(), "NOGROUP") {
				groupOK = false
				continue
			}
			f.log.Warn("XREADGROUP dlr-out failed", "err", err)
			sleep(ctx, 500*time.Millisecond)
			continue
		}
		for _, s := range res {
			for _, msg := range s.Messages {
				run(msg.ID, msg.Values)
			}
		}
	}
}

func (f *Forwarder) reclaim(ctx context.Context, run func(string, map[string]any)) {
	start := "0-0"
	for ctx.Err() == nil {
		msgs, next, err := f.rdb.XAutoClaim(ctx, &redis.XAutoClaimArgs{
			Stream: f.opts.Stream, Group: f.opts.Group, Consumer: f.opts.Consumer,
			MinIdle: f.opts.RetryIdle, Start: start, Count: int64(f.opts.Batch),
		}).Result()
		if err != nil {
			if !errors.Is(err, redis.Nil) && ctx.Err() == nil {
				f.log.Warn("XAUTOCLAIM dlr-out failed", "err", err)
			}
			return
		}
		for _, m := range msgs {
			run(m.ID, m.Values)
		}
		if next == "" || next == "0-0" || len(msgs) == 0 {
			return
		}
		start = next
	}
}

func (f *Forwarder) claim(id string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	if _, ok := f.inproc[id]; ok {
		return false
	}
	f.inproc[id] = struct{}{}
	return true
}

func (f *Forwarder) release(id string) {
	f.mu.Lock()
	delete(f.inproc, id)
	f.mu.Unlock()
}

func sleep(ctx context.Context, d time.Duration) {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-t.C:
	case <-ctx.Done():
	}
}

func (f *Forwarder) ack(id string) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, err := f.rdb.Pipelined(ctx, func(p redis.Pipeliner) error {
		p.XAck(ctx, f.opts.Stream, f.opts.Group, id)
		p.XDel(ctx, f.opts.Stream, id)
		return nil
	})
	if err != nil {
		f.log.Warn("ack dlr-out failed", "entry", id, "err", err)
	}
}

// handle processes one event; false leaves it pending for a retry.
func (f *Forwarder) handle(ctx context.Context, id string, values map[string]any) bool {
	raw, _ := values[EventField].(string)
	var ev Event
	if err := json.Unmarshal([]byte(raw), &ev); err != nil || ev.MessageID == "" {
		f.log.Error("dropping malformed dlr-out entry", "entry", id, "err", err)
		return true
	}
	// Webhooks first: the queue is idempotent per (webhook, message), so a
	// retried event never posts twice.
	if f.wh != nil && f.src != nil {
		if snap := f.src.Current(); snap != nil {
			hooks := snap.WebhooksFor(ev.OrgID, "dlr")
			if len(hooks) > 0 {
				body, err := json.Marshal(WebhookPayload(ev))
				if err != nil {
					f.log.Error("marshal webhook payload", "err", err)
					return true
				}
				for _, w := range hooks {
					if err := f.wh.Enqueue(ctx, webhook.Delivery{WebhookID: w.ID, OrgID: ev.OrgID, MessageID: ev.MessageID, Event: "dlr", Body: body}); err != nil {
						f.m.DLRForwarded.With("webhook", "error").Inc()
						f.log.Warn("enqueue webhook failed; will retry", "message_id", ev.MessageID, "err", err)
						return false
					}
					f.m.DLRForwarded.With("webhook", "queued").Inc()
				}
			}
		}
	}
	if ev.SMPPSystemID == "" || f.smpp == nil || !wantsReceipt(ev.RegDelivery, ev.Status) {
		return true
	}
	dctx, cancel := context.WithTimeout(ctx, f.opts.DeliverTimeout)
	defer cancel()
	_, err := f.smpp.Deliver(dctx, ev.SMPPSystemID, ReceiptPDU(ev))
	if err == nil {
		f.m.DLRForwarded.With("smpp", "ok").Inc()
		return true
	}
	var se *pdu.StatusError
	if errors.As(err, &se) && se.Status != pdu.ESME_RX_T_APPN && se.Status != pdu.ESME_RTHROTTLED && se.Status != pdu.ESME_RMSGQFUL {
		f.m.DLRForwarded.With("smpp", "rejected").Inc()
		f.log.Warn("client rejected delivery receipt", "message_id", ev.MessageID, "system_id", ev.SMPPSystemID, "status", se.Status.String())
		return true
	}
	if f.opts.Now().Sub(ev.EnqueuedAt) > f.opts.MaxAge {
		f.m.DLRForwarded.With("smpp", "expired").Inc()
		f.log.Warn("giving up delivering receipt to SMPP client", "message_id", ev.MessageID, "system_id", ev.SMPPSystemID, "err", err)
		return true
	}
	f.m.DLRForwarded.With("smpp", "retry").Inc()
	f.log.Debug("SMPP receipt not delivered; will retry", "message_id", ev.MessageID, "system_id", ev.SMPPSystemID, "err", err)
	return false
}

// wantsReceipt applies the client's registered_delivery bits: 1 = always,
// 2 = failures only, 0 = never (3 is reserved; treated as always).
func wantsReceipt(rd int, status string) bool {
	switch rd & 0x03 {
	case 0:
		return false
	case 2:
		return status != cdr.StatusDelivered
	}
	return true
}

// WebhookBody is the CONTRACTS §9 dlr webhook payload.
type WebhookBody struct {
	Event       string     `json:"event"`
	MessageID   string     `json:"message_id"`
	ClientRef   *string    `json:"client_ref"`
	To          string     `json:"to"`
	From        string     `json:"from"`
	Status      string     `json:"status"`
	DLRStat     string     `json:"dlr_stat"`
	DLRErr      string     `json:"dlr_err"`
	Parts       int        `json:"parts"`
	SubmittedAt *time.Time `json:"submitted_at"`
	DoneAt      time.Time  `json:"done_at"`
}

// WebhookPayload builds the webhook body for an event.
func WebhookPayload(ev Event) WebhookBody {
	b := WebhookBody{Event: "dlr", MessageID: ev.MessageID, To: ev.To, From: ev.From, Status: ev.Status,
		DLRStat: ev.DLRStat, DLRErr: ev.DLRErr, Parts: ev.Parts, SubmittedAt: ev.SubmittedAt, DoneAt: ev.DoneAt}
	if ev.ClientRef != "" && ev.Channel != store.ChannelSMPP {
		c := ev.ClientRef
		b.ClientRef = &c
	}
	return b
}

// ReceiptPDU builds the deliver_sm receipt for an SMPP client (CONTRACTS §9).
func ReceiptPDU(ev Event) *pdu.DeliverSM {
	dlvrd := 0
	if ev.Status == cdr.StatusDelivered {
		dlvrd = 1
	}
	stat := ev.DLRStat
	if stat == "" {
		stat = StatForStatus(ev.Status)
	}
	r := pdu.Receipt{ID: ev.MessageID, Sub: 1, Dlvrd: dlvrd, SubmitDate: ev.CreatedAt, DoneDate: ev.DoneAt,
		Stat: stat, Err: normalizeErr(ev.DLRErr), Text: asciiSafe(ev.Text)}
	text := []byte(r.Format())
	if len(text) > pdu.MaxShortMessageLen {
		text = text[:pdu.MaxShortMessageLen]
	}
	d := &pdu.DeliverSM{
		SourceAddrTON: phone.TONInternational, SourceAddrNPI: phone.NPIE164, SourceAddr: ev.To,
		DestinationAddr: ev.From, ESMClass: pdu.ESMClassMCDeliveryRcpt, DataCoding: 0, ShortMessage: text,
	}
	if s, err := phone.ClassifySender(ev.From); err == nil {
		d.DestAddrTON, d.DestAddrNPI, d.DestinationAddr = s.TON, s.NPI, s.Normalized
	}
	d.TLVs.SetReceiptedMessageID(ev.MessageID)
	if st, ok := pdu.MessageStateFromStat(stat); ok {
		d.TLVs.SetMessageState(st)
	}
	return d
}

// asciiSafe keeps receipt text 7-bit clean (it travels with data_coding 0).
func asciiSafe(s string) string {
	b := make([]byte, 0, len(s))
	for _, r := range s {
		if r >= 0x20 && r < 0x7f {
			b = append(b, byte(r))
		} else {
			b = append(b, '?')
		}
	}
	return string(b)
}
