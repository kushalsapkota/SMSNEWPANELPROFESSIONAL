package dlr

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"

	"smsgw/engine/internal/cdr"
	"smsgw/engine/internal/metrics"
	"smsgw/engine/internal/pipeline"
	"smsgw/engine/internal/smpp/pdu"
)

// Event is one client notification on q:dlr-out (field "e", JSON).
type Event struct {
	MessageID    string     `json:"message_id"`
	OrgID        string     `json:"org_id"`
	Channel      string     `json:"channel"`
	ClientRef    string     `json:"client_ref,omitempty"`
	SMPPSystemID string     `json:"smpp_system_id,omitempty"`
	RegDelivery  int        `json:"rd"` // client registered_delivery (SMPP)
	To           string     `json:"to"`
	From         string     `json:"from"`
	Status       string     `json:"status"`
	DLRStat      string     `json:"dlr_stat"`
	DLRErr       string     `json:"dlr_err"`
	Parts        int        `json:"parts"`
	Text         string     `json:"text,omitempty"` // first 20 characters (receipt text)
	CreatedAt    time.Time  `json:"created_at"`
	SubmittedAt  *time.Time `json:"submitted_at"`
	DoneAt       time.Time  `json:"done_at"`
	EnqueuedAt   time.Time  `json:"enqueued_at"`
}

// EventField is the q:dlr-out entry field.
const EventField = "e"

// Options tune a Processor.
type Options struct {
	Stream     string        // client DLR stream; default pipeline.DLROutStream
	LookupWait time.Duration // wait for a dlrmap entry racing the submit_sm_resp; default 3s
	Logger     *slog.Logger
	Metrics    *metrics.Engine
	Now        func() time.Time
}

// Processor handles upstream receipts and dispatcher outcomes. It implements
// dispatch.Finalizer.
type Processor struct {
	rdb  redis.UniversalClient
	sink pipeline.CDRSink
	db   *pgxpool.Pool
	opts Options
	log  *slog.Logger
	m    *metrics.Engine
}

// NewProcessor creates a Processor. db (optional) enables the
// message_logs.smsc_msg_ids fallback for receipts whose dlrmap expired.
func NewProcessor(rdb redis.UniversalClient, sink pipeline.CDRSink, db *pgxpool.Pool, o Options) *Processor {
	if o.Stream == "" {
		o.Stream = pipeline.DLROutStream
	}
	if o.LookupWait <= 0 {
		o.LookupWait = 3 * time.Second
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
	return &Processor{rdb: rdb, sink: sink, db: db, opts: o, log: o.Logger.With("component", "dlr"), m: o.Metrics}
}

// HandleDeliver processes a deliver_sm from upstream connection connID and
// returns the deliver_sm_resp status. Infrastructure errors answer
// ESME_RX_T_APPN so the SMSC redelivers the receipt later.
func (p *Processor) HandleDeliver(connID string, d *pdu.DeliverSM) pdu.CommandStatus {
	r, ok := pdu.ReceiptFromDeliverSM(d)
	if !ok {
		if pdu.IsDeliveryReceipt(d.ESMClass) {
			p.m.DLRReceived.With("unparseable").Inc()
			p.log.Warn("unparseable delivery receipt", "connection_id", connID, "text", string(d.Payload()))
		} else {
			p.m.DLRReceived.With("mo").Inc()
			p.log.Debug("ignoring mobile-originated message", "connection_id", connID, "from", d.SourceAddr)
		}
		return pdu.ESME_ROK
	}
	status, final := StatusForStat(r.Stat)
	if !final {
		p.m.DLRReceived.With("intermediate").Inc()
		return pdu.ESME_ROK
	}
	p.m.DLRReceived.With(r.Stat).Inc()
	ctx, cancel := context.WithTimeout(context.Background(), p.opts.LookupWait+10*time.Second)
	defer cancel()

	msgID, part, createdMS, found, err := p.lookup(ctx, connID, r.ID)
	if err != nil {
		p.log.Warn("dlrmap lookup failed", "connection_id", connID, "smsc_id", r.ID, "err", err)
		return pdu.ESME_RX_T_APPN
	}
	stat := truncate(r.Stat, 7)
	errCode := normalizeErr(r.Err)
	doneAt := r.DoneDate
	if doneAt.IsZero() {
		doneAt = p.opts.Now().UTC()
	}
	if !found {
		return p.fallback(ctx, connID, r.ID, status, stat, errCode)
	}
	o, err := RecordPart(ctx, p.rdb, msgID, part, status, stat, errCode)
	if err != nil {
		p.log.Warn("record DLR failed", "message_id", msgID, "err", err)
		return pdu.ESME_RX_T_APPN
	}
	switch o.Kind {
	case OutcomeFinal:
		if err := p.finalize(ctx, msgID, createdMS, o.Status, o.DLRStat, o.DLRErr, doneAt); err != nil {
			p.log.Error("finalize DLR failed", "message_id", msgID, "err", err)
			return pdu.ESME_RX_T_APPN
		}
	case OutcomeNoMsg:
		// Message state expired: update the CDR as a single final outcome.
		p.updateCDR(ctx, msgID, time.UnixMilli(createdMS).UTC(), status, stat, errCode)
	}
	return pdu.ESME_ROK
}

// lookup resolves an SMSC id through dlrmap, waiting a little for an entry
// whose submit_sm_resp is still being recorded.
func (p *Processor) lookup(ctx context.Context, connID, smscID string) (msgID string, part int, createdMS int64, found bool, err error) {
	variants := pdu.MessageIDVariants(smscID)
	keys := make([]string, 0, len(variants))
	for _, v := range variants {
		if v != "" {
			keys = append(keys, pipeline.DLRMapKey(connID, v))
		}
	}
	if len(keys) == 0 {
		return "", 0, 0, false, nil
	}
	deadline := time.Now().Add(p.opts.LookupWait)
	delay := 20 * time.Millisecond
	for {
		vals, err := p.rdb.MGet(ctx, keys...).Result()
		if err != nil {
			return "", 0, 0, false, err
		}
		for _, v := range vals {
			s, ok := v.(string)
			if !ok {
				continue
			}
			id, part, created, perr := pipeline.ParseDLRMapValue(s)
			if perr != nil {
				p.log.Warn("bad dlrmap value", "value", s)
				continue
			}
			return id, part, created, true, nil
		}
		if time.Now().Add(delay).After(deadline) {
			return "", 0, 0, false, nil
		}
		select {
		case <-time.After(delay):
		case <-ctx.Done():
			return "", 0, 0, false, ctx.Err()
		}
		delay = min(delay*2, 500*time.Millisecond)
	}
}

// fallback matches a receipt whose dlrmap entry is gone against
// message_logs.smsc_msg_ids (GIN index) for the last 35 days.
func (p *Processor) fallback(ctx context.Context, connID, smscID, status, stat, errCode string) pdu.CommandStatus {
	if p.db == nil {
		p.m.DLRReceived.With("unmatched").Inc()
		p.log.Warn("unmatched delivery receipt", "connection_id", connID, "smsc_id", smscID)
		return pdu.ESME_ROK
	}
	cands := []string{strings.TrimSpace(smscID)}
	for _, v := range pdu.MessageIDVariants(smscID) {
		cands = append(cands, v, strings.ToUpper(v))
	}
	var id string
	var created time.Time
	err := p.db.QueryRow(ctx, `
		SELECT id::text, created_at FROM message_logs
		 WHERE smsc_msg_ids && $1::text[] AND connection_id = $2
		   AND created_at > now() - interval '35 days'
		 ORDER BY created_at DESC LIMIT 1`, cands, connID).Scan(&id, &created)
	if errors.Is(err, pgx.ErrNoRows) {
		p.m.DLRReceived.With("unmatched").Inc()
		p.log.Warn("unmatched delivery receipt", "connection_id", connID, "smsc_id", smscID)
		return pdu.ESME_ROK
	}
	if err != nil {
		p.log.Warn("DLR fallback lookup failed", "err", err)
		return pdu.ESME_RX_T_APPN
	}
	p.updateCDR(ctx, id, created, status, stat, errCode)
	return pdu.ESME_ROK
}

func (p *Processor) updateCDR(ctx context.Context, msgID string, created time.Time, status, stat, errCode string) {
	now := p.opts.Now().UTC()
	if err := p.sink.Update(ctx, cdr.Update{ID: msgID, CreatedAt: created, Status: status, DLRStat: &stat, DLRErr: &errCode, DLRReceivedAt: &now}); err != nil {
		p.log.Error("cdr update failed", "message_id", msgID, "err", err)
	}
}

func truncate(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}

// finalize writes the final CDR status and emits the client event.
func (p *Processor) finalize(ctx context.Context, msgID string, createdMS int64, status, stat, errCode string, doneAt time.Time) error {
	p.m.DLRFinal.With(status).Inc()
	now := p.opts.Now().UTC()
	upd := cdr.Update{ID: msgID, CreatedAt: time.UnixMilli(createdMS).UTC(), Status: status, DLRReceivedAt: &now}
	if stat != "" {
		upd.DLRStat = &stat
	}
	e := normalizeErr(errCode)
	upd.DLRErr = &e
	if err := p.sink.Update(ctx, upd); err != nil {
		p.log.Error("cdr update failed", "message_id", msgID, "err", err)
	}
	if stat == "" {
		stat = StatForStatus(status)
	}
	return p.emit(ctx, msgID, status, stat, e, doneAt)
}

// emit appends the client event for msgID to the DLR stream.
func (p *Processor) emit(ctx context.Context, msgID, status, stat, errCode string, doneAt time.Time) error {
	h, err := p.rdb.HGetAll(ctx, pipeline.MsgKey(msgID)).Result()
	if err != nil {
		return err
	}
	if len(h) == 0 {
		p.log.Warn("message state expired; client not notified", "message_id", msgID)
		return nil
	}
	ev := Event{
		MessageID: msgID, OrgID: h[pipeline.FOrgID], Channel: h[pipeline.FChannel], ClientRef: h[pipeline.FClientRef],
		SMPPSystemID: h[pipeline.FSMPPSystemID], To: h[pipeline.FDest], From: h[pipeline.FSource],
		Status: status, DLRStat: stat, DLRErr: errCode, Text: h[pipeline.FText20],
		DoneAt: doneAt.UTC(), EnqueuedAt: p.opts.Now().UTC(),
	}
	ev.RegDelivery, _ = strconv.Atoi(h[pipeline.FRegDelivery])
	ev.Parts, _ = strconv.Atoi(h[pipeline.FParts])
	if ms, err := strconv.ParseInt(h[pipeline.FCreatedAtMS], 10, 64); err == nil {
		ev.CreatedAt = time.UnixMilli(ms).UTC()
	}
	if ms, err := strconv.ParseInt(h[pipeline.FSubmittedMS], 10, 64); err == nil {
		t := time.UnixMilli(ms).UTC()
		ev.SubmittedAt = &t
	}
	b, err := json.Marshal(ev)
	if err != nil {
		return err
	}
	if err := p.rdb.XAdd(ctx, &redis.XAddArgs{Stream: p.opts.Stream, Values: []any{EventField, string(b)}}).Err(); err != nil {
		return fmt.Errorf("dlr: xadd %s: %w", p.opts.Stream, err)
	}
	return nil
}

// MessageFailed implements dispatch.Finalizer: nothing was accepted
// upstream (or the route became unavailable).
func (p *Processor) MessageFailed(ctx context.Context, job *pipeline.DispatchJob, errorCode string, refunded bool) error {
	key := pipeline.MsgKey(job.ID)
	first, err := p.rdb.HSetNX(ctx, key, pipeline.FDone, 1).Result()
	if err != nil {
		return err
	}
	upd := cdr.Update{ID: job.ID, CreatedAt: job.CreatedAt(), Status: cdr.StatusFailed, ErrorCode: &errorCode}
	if refunded {
		upd.Refunded = &refunded
	}
	if err := p.sink.Update(ctx, upd); err != nil {
		p.log.Error("cdr update failed", "message_id", job.ID, "err", err)
	}
	if !first {
		return nil // already finalized elsewhere
	}
	p.rdb.HSet(ctx, key, pipeline.FStatus, cdr.StatusFailed)
	p.m.DLRFinal.With(cdr.StatusFailed).Inc()
	return p.emit(ctx, job.ID, cdr.StatusFailed, StatForStatus(cdr.StatusFailed), "000", p.opts.Now())
}

// PartsFailed implements dispatch.Finalizer for parts rejected upstream.
func (p *Processor) PartsFailed(ctx context.Context, job *pipeline.DispatchJob, parts []int, errorCode string) error {
	if err := p.sink.Update(ctx, cdr.Update{ID: job.ID, CreatedAt: job.CreatedAt(), ErrorCode: &errorCode}); err != nil {
		p.log.Error("cdr update failed", "message_id", job.ID, "err", err)
	}
	for _, idx := range parts {
		o, err := RecordPart(ctx, p.rdb, job.ID, idx, cdr.StatusFailed, "", "000")
		if err != nil {
			return err
		}
		if o.Kind == OutcomeFinal {
			return p.finalize(ctx, job.ID, job.CreatedMS, o.Status, o.DLRStat, o.DLRErr, p.opts.Now())
		}
	}
	return nil
}
