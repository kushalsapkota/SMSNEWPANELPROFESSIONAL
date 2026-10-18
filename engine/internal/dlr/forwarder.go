package dlr

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"math/rand/v2"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"

	"smsgw/engine/internal/cdr"
	"smsgw/engine/internal/metrics"
	"smsgw/engine/internal/phone"
	"smsgw/engine/internal/pipeline"
	"smsgw/engine/internal/smpp/pdu"
	"smsgw/engine/internal/smpp/server"
	"smsgw/engine/internal/store"
	"smsgw/engine/internal/webhook"
)

// SMPPDeliverer pushes a deliver_sm to a bound client session
// (*server.Server).
type SMPPDeliverer interface {
	// DeliverTo delivers to a bound RX/TRX session of systemID that belongs
	// to orgID (server.ErrNoSession when there is none).
	DeliverTo(ctx context.Context, orgID, systemID string, d *pdu.DeliverSM) (*pdu.DeliverSMResp, error)
	// HasReceiverFor reports whether such a session is bound here.
	HasReceiverFor(orgID, systemID string) bool
}

// ReceiverLister (optionally implemented by the SMPPDeliverer) lists the
// (org, system_id) pairs with a bound RX/TRX session on this instance; the
// Forwarder publishes them so other instances can route receipts here.
type ReceiverLister interface {
	Receivers() []server.ReceiverKey
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
	Consumer       string        // consumer name = instance id (unique per instance); default "engine"
	Workers        int           // concurrent events; default 16
	Batch          int           // XREADGROUP count; default 100
	Block          time.Duration // default 1s
	RetryIdle      time.Duration // an unacked event is retried after this; default 30s
	ReclaimMax     int           // pending events retried per reclaim pass; default 1000
	MaxAge         time.Duration // give up delivering to SMPP after; default 72h
	DeliverTimeout time.Duration // deliver_sm_resp wait; default 10s
	// RegistryTTL: how long this instance's advertisement of its bound
	// receivers stays valid (refreshed every RegistryTTL/3); default 30s.
	RegistryTTL time.Duration
	Logger      *slog.Logger
	Metrics     *metrics.Engine
	Now         func() time.Time
}

// Forwarder consumes q:dlr-out.
//
// Multi-instance: every instance advertises the SMPP receivers bound to it
// (smpp:rx:<system_id> → instance) and consumes its own stream
// <Stream>:i:<instance> besides the shared one. A receipt whose client is
// bound to another instance is handed to that instance's stream instead of
// waiting for a random instance to hold the session. Streams of instances
// that stopped heart-beating are moved back to the shared stream.
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
	rxSeen map[string]bool // registry fields this instance published (system_id -> true)
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
	if o.ReclaimMax <= 0 {
		o.ReclaimMax = 1000
	}
	if o.MaxAge <= 0 {
		o.MaxAge = 72 * time.Hour
	}
	if o.DeliverTimeout <= 0 {
		o.DeliverTimeout = 10 * time.Second
	}
	if o.RegistryTTL <= 0 {
		o.RegistryTTL = 30 * time.Second
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
		log: o.Logger.With("component", "dlr-forwarder"), m: o.Metrics, inproc: map[string]struct{}{}, rxSeen: map[string]bool{}}
}

// instanceStream is the per-instance stream of instance.
func (f *Forwarder) instanceStream(instance string) string { return f.opts.Stream + ":i:" + instance }

// instancesKey is the hash instance -> last heartbeat (unix ms).
func (f *Forwarder) instancesKey() string { return f.opts.Stream + ":instances" }

// RegistryKey is the receiver registry hash of systemID: instance ->
// "<org_id>|<valid until unix ms>".
func RegistryKey(systemID string) string { return "smpp:rx:" + systemID }

// consumer is one stream this Forwarder reads.
type consumer struct {
	stream string
	shared bool // the shared stream (webhooks + SMPP); else this instance's own (SMPP only)
}

// Run consumes events until ctx is cancelled and waits for in-flight ones.
func (f *Forwarder) Run(ctx context.Context) {
	sem := make(chan struct{}, f.opts.Workers)
	var wg sync.WaitGroup // event handlers
	run := func(c consumer, id string, values map[string]any) bool {
		key := c.stream + "/" + id
		if !f.claim(key) {
			return false
		}
		select {
		case sem <- struct{}{}:
		case <-ctx.Done():
			f.release(key)
			return false
		}
		wg.Add(1)
		go func() {
			defer func() { <-sem; wg.Done(); f.release(key) }()
			if f.handle(context.WithoutCancel(ctx), c, id, values) {
				f.ack(c.stream, id)
			}
		}()
		return true
	}
	shared := consumer{stream: f.opts.Stream, shared: true}
	own := consumer{stream: f.instanceStream(f.opts.Consumer)}

	var loops sync.WaitGroup
	loops.Add(4)
	go func() { defer loops.Done(); f.readLoop(ctx, []consumer{shared, own}, sem, run) }()
	go func() { defer loops.Done(); f.reclaimLoop(ctx, shared, run) }()
	go func() { defer loops.Done(); f.reclaimLoop(ctx, own, run) }()
	go func() { defer loops.Done(); f.registryLoop(ctx) }()
	loops.Wait()
	wg.Wait()
	f.unregister()
}

func (f *Forwarder) ensureGroup(ctx context.Context, stream string) bool {
	err := f.rdb.XGroupCreateMkStream(ctx, stream, f.opts.Group, "0").Err()
	if err != nil && !strings.Contains(err.Error(), "BUSYGROUP") {
		if ctx.Err() == nil {
			f.log.Warn("create dlr-out group failed", "stream", stream, "err", err)
		}
		return false
	}
	return true
}

func (f *Forwarder) readLoop(ctx context.Context, cs []consumer, sem chan struct{}, run func(consumer, string, map[string]any) bool) {
	groupOK := false
	byStream := map[string]consumer{}
	streams := make([]string, 0, 2*len(cs))
	for _, c := range cs {
		byStream[c.stream] = c
		streams = append(streams, c.stream)
	}
	for range cs {
		streams = append(streams, ">")
	}
	for ctx.Err() == nil {
		if !groupOK {
			groupOK = true
			for _, c := range cs {
				if !f.ensureGroup(ctx, c.stream) {
					groupOK = false
				}
			}
			if !groupOK {
				sleep(ctx, time.Second)
				continue
			}
		}
		free := cap(sem) - len(sem)
		if free == 0 {
			sleep(ctx, 20*time.Millisecond)
			continue
		}
		res, err := f.rdb.XReadGroup(ctx, &redis.XReadGroupArgs{
			Group: f.opts.Group, Consumer: f.opts.Consumer, Streams: streams,
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
			c := byStream[s.Stream]
			for _, msg := range s.Messages {
				run(c, msg.ID, msg.Values)
			}
		}
	}
}

// reclaimLoop retries events left pending (client not bound, transient
// errors, crashed consumers) at most ReclaimMax per pass, every RetryIdle/2,
// continuing where the previous pass stopped. It runs beside the read loop
// so a large backlog of receipts for offline clients never delays new ones.
func (f *Forwarder) reclaimLoop(ctx context.Context, c consumer, run func(consumer, string, map[string]any) bool) {
	t := time.NewTicker(f.opts.RetryIdle / 2)
	defer t.Stop()
	start := "0-0"
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		claimed := 0
		for ctx.Err() == nil && claimed < f.opts.ReclaimMax {
			msgs, next, err := f.rdb.XAutoClaim(ctx, &redis.XAutoClaimArgs{
				Stream: c.stream, Group: f.opts.Group, Consumer: f.opts.Consumer,
				MinIdle: f.opts.RetryIdle, Start: start, Count: int64(min(f.opts.Batch, f.opts.ReclaimMax-claimed)),
			}).Result()
			if err != nil {
				if !errors.Is(err, redis.Nil) && ctx.Err() == nil && !strings.Contains(err.Error(), "NOGROUP") {
					f.log.Warn("XAUTOCLAIM dlr-out failed", "stream", c.stream, "err", err)
				}
				break
			}
			for _, m := range msgs {
				if run(c, m.ID, m.Values) {
					claimed++
				}
			}
			if next == "" || next == "0-0" {
				start = "0-0"
				break
			}
			start = next
			if len(msgs) == 0 {
				break
			}
		}
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

func (f *Forwarder) ack(stream, id string) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, err := f.rdb.Pipelined(ctx, func(p redis.Pipeliner) error {
		p.XAck(ctx, stream, f.opts.Group, id)
		p.XDel(ctx, stream, id)
		return nil
	})
	if err != nil {
		f.log.Warn("ack dlr-out failed", "entry", id, "err", err)
	}
}

// handle processes one event; false leaves it pending for a retry.
func (f *Forwarder) handle(ctx context.Context, c consumer, id string, values map[string]any) bool {
	raw, _ := values[EventField].(string)
	var ev Event
	if err := json.Unmarshal([]byte(raw), &ev); err != nil || ev.MessageID == "" {
		f.log.Error("dropping malformed dlr-out entry", "entry", id, "err", err)
		return true
	}
	// Webhooks first: the queue is idempotent per (webhook, message), so a
	// retried event never posts twice.
	if c.shared && !ev.SkipWebhook && f.wh != nil && f.src != nil {
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
	// The system_id must still be the same tenant's account: a deleted
	// system_id may be re-created by another organization while receipts
	// for the old one are queued.
	if f.src != nil {
		if snap := f.src.Current(); snap != nil {
			if acct := snap.SMPPAccount(ev.SMPPSystemID); acct == nil || acct.OrgID != ev.OrgID {
				f.m.DLRForwarded.With("smpp", "account_gone").Inc()
				f.log.Info("dropping SMPP receipt: account removed or reassigned", "message_id", ev.MessageID, "system_id", ev.SMPPSystemID)
				return true
			}
		}
	}
	expired := func() bool { return f.opts.Now().Sub(ev.EnqueuedAt) > f.opts.MaxAge }
	if !f.smpp.HasReceiverFor(ev.OrgID, ev.SMPPSystemID) {
		// Bound to another instance? Hand it over.
		if inst := f.remoteReceiver(ctx, ev.OrgID, ev.SMPPSystemID); inst != "" {
			if f.handOver(ctx, f.instanceStream(inst), ev) {
				f.m.DLRForwarded.With("smpp", "routed").Inc()
				return true
			}
			return false
		}
		if !c.shared {
			// Our client went away: back to the shared stream for whoever
			// holds it next (webhooks are already done).
			return f.handOver(ctx, f.opts.Stream, ev)
		}
		if expired() {
			f.m.DLRForwarded.With("smpp", "expired").Inc()
			f.log.Warn("giving up delivering receipt to SMPP client", "message_id", ev.MessageID, "system_id", ev.SMPPSystemID)
			return true
		}
		f.m.DLRForwarded.With("smpp", "retry").Inc()
		return false
	}
	dctx, cancel := context.WithTimeout(ctx, f.opts.DeliverTimeout)
	defer cancel()
	_, err := f.smpp.DeliverTo(dctx, ev.OrgID, ev.SMPPSystemID, ReceiptPDU(ev))
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
	if expired() {
		f.m.DLRForwarded.With("smpp", "expired").Inc()
		f.log.Warn("giving up delivering receipt to SMPP client", "message_id", ev.MessageID, "system_id", ev.SMPPSystemID, "err", err)
		return true
	}
	f.m.DLRForwarded.With("smpp", "retry").Inc()
	f.log.Debug("SMPP receipt not delivered; will retry", "message_id", ev.MessageID, "system_id", ev.SMPPSystemID, "err", err)
	return false
}

// handOver appends ev (webhooks done) to stream.
func (f *Forwarder) handOver(ctx context.Context, stream string, ev Event) bool {
	ev.SkipWebhook = true
	b, err := json.Marshal(ev)
	if err != nil {
		return true
	}
	if err := f.rdb.XAdd(ctx, &redis.XAddArgs{Stream: stream, Values: []any{EventField, string(b)}}).Err(); err != nil {
		f.log.Warn("hand over receipt failed; will retry", "message_id", ev.MessageID, "stream", stream, "err", err)
		return false
	}
	return true
}

// remoteReceiver returns another live instance advertising a receiver for
// (orgID, systemID), or "".
func (f *Forwarder) remoteReceiver(ctx context.Context, orgID, systemID string) string {
	h, err := f.rdb.HGetAll(ctx, RegistryKey(systemID)).Result()
	if err != nil || len(h) == 0 {
		return ""
	}
	now := f.opts.Now().UnixMilli()
	var cands []string
	for inst, v := range h {
		if inst == f.opts.Consumer {
			continue
		}
		org, until, ok := strings.Cut(v, "|")
		if !ok || org != orgID {
			continue
		}
		if ms, err := strconv.ParseInt(until, 10, 64); err != nil || ms < now {
			continue
		}
		cands = append(cands, inst)
	}
	if len(cands) == 0 {
		return ""
	}
	sort.Strings(cands)
	return cands[rand.IntN(len(cands))]
}

// registryLoop advertises this instance's receivers and heartbeat, and
// recovers the streams of dead instances.
func (f *Forwarder) registryLoop(ctx context.Context) {
	every := f.opts.RegistryTTL / 3
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		f.publishReceivers(ctx)
		f.recoverDeadInstances(ctx)
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

func (f *Forwarder) publishReceivers(ctx context.Context) {
	lister, ok := f.smpp.(ReceiverLister)
	if !ok || ctx.Err() != nil {
		return
	}
	now := f.opts.Now()
	until := strconv.FormatInt(now.Add(f.opts.RegistryTTL).UnixMilli(), 10)
	current := map[string]string{}
	for _, r := range lister.Receivers() {
		current[r.SystemID] = r.OrgID
	}
	f.mu.Lock()
	var gone []string
	for sys := range f.rxSeen {
		if _, ok := current[sys]; !ok {
			gone = append(gone, sys)
			delete(f.rxSeen, sys)
		}
	}
	for sys := range current {
		f.rxSeen[sys] = true
	}
	f.mu.Unlock()
	_, err := f.rdb.Pipelined(ctx, func(p redis.Pipeliner) error {
		p.HSet(ctx, f.instancesKey(), f.opts.Consumer, now.UnixMilli())
		for sys, org := range current {
			p.HSet(ctx, RegistryKey(sys), f.opts.Consumer, org+"|"+until)
			p.Expire(ctx, RegistryKey(sys), 2*f.opts.RegistryTTL)
		}
		for _, sys := range gone {
			p.HDel(ctx, RegistryKey(sys), f.opts.Consumer)
		}
		return nil
	})
	if err != nil && ctx.Err() == nil {
		f.log.Warn("publish SMPP receiver registry failed", "err", err)
	}
}

// unregister removes this instance's registry entries on shutdown (its own
// stream is drained back by the next recovery on another instance, or
// consumed again after a restart with the same instance id).
func (f *Forwarder) unregister() {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	f.mu.Lock()
	sys := make([]string, 0, len(f.rxSeen))
	for s := range f.rxSeen {
		sys = append(sys, s)
	}
	f.rxSeen = map[string]bool{}
	f.mu.Unlock()
	_, _ = f.rdb.Pipelined(ctx, func(p redis.Pipeliner) error {
		for _, s := range sys {
			p.HDel(ctx, RegistryKey(s), f.opts.Consumer)
		}
		return nil
	})
}

// recoverDeadInstances moves the per-instance streams of instances whose
// heartbeat is older than 4×RegistryTTL back to the shared stream.
func (f *Forwarder) recoverDeadInstances(ctx context.Context) {
	h, err := f.rdb.HGetAll(ctx, f.instancesKey()).Result()
	if err != nil {
		return
	}
	cutoff := f.opts.Now().Add(-4 * f.opts.RegistryTTL).UnixMilli()
	for inst, v := range h {
		if inst == f.opts.Consumer {
			continue
		}
		if ms, err := strconv.ParseInt(v, 10, 64); err == nil && ms >= cutoff {
			continue
		}
		lock := f.opts.Stream + ":recover:" + inst
		if ok, err := f.rdb.SetNX(ctx, lock, f.opts.Consumer, time.Minute).Result(); err != nil || !ok {
			continue
		}
		f.drainInstance(ctx, inst)
		f.rdb.Del(ctx, lock)
	}
}

func (f *Forwarder) drainInstance(ctx context.Context, inst string) {
	stream := f.instanceStream(inst)
	moved := 0
	for ctx.Err() == nil {
		msgs, err := f.rdb.XRangeN(ctx, stream, "-", "+", 500).Result()
		if err != nil {
			return
		}
		if len(msgs) == 0 {
			f.rdb.Del(ctx, stream)
			f.rdb.HDel(ctx, f.instancesKey(), inst)
			if moved > 0 {
				f.log.Info("moved receipts of a dead instance back to the shared stream", "instance", inst, "events", moved)
			}
			return
		}
		for _, m := range msgs {
			if err := f.rdb.XAdd(ctx, &redis.XAddArgs{Stream: f.opts.Stream, Values: m.Values}).Err(); err != nil {
				return
			}
			f.rdb.XDel(ctx, stream, m.ID)
			moved++
		}
	}
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
