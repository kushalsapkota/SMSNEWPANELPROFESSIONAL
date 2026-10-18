package dlr

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math/big"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
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
	// SkipWebhook: webhooks were already enqueued (event handed over to
	// another instance for SMPP delivery).
	SkipWebhook bool `json:"skip_wh,omitempty"`
}

// EventField is the q:dlr-out entry field.
const EventField = "e"

// Options tune a Processor.
type Options struct {
	Stream     string        // client DLR stream; default pipeline.DLROutStream
	LookupWait time.Duration // wait for a dlrmap entry racing the submit_sm_resp; default 3s
	// UnmatchedRetries: a receipt matching no message is answered
	// ESME_RX_T_APPN this many times before it is acknowledged; default 3.
	UnmatchedRetries int
	Logger           *slog.Logger
	Metrics          *metrics.Engine
	Now              func() time.Time
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

	forms sync.Map // connection id -> idForm its receipts use
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
	if o.UnmatchedRetries == 0 {
		o.UnmatchedRetries = 3
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
	ctx, cancel := context.WithTimeout(context.Background(), p.opts.LookupWait+10*time.Second)
	defer cancel()
	switch p.applyReceipt(ctx, connID, r.ID, r.Stat, r.Err, false) {
	case receiptRetry:
		return pdu.ESME_RX_T_APPN
	case receiptUnmatched:
		return p.unmatched(ctx, connID, r.ID)
	}
	return pdu.ESME_ROK
}

// HandleProviderReceipt applies a delivery status reported by an HTTP
// provider (DLR poll or callback) for providerID on connection connID; stat
// is a receipt word (DELIVRD, UNDELIV, EXPIRED, REJECTD, UNKNOWN...). The id
// is matched exactly (no hex/decimal variants). It implements
// dispatch.ReceiptSink.
func (p *Processor) HandleProviderReceipt(ctx context.Context, connID, providerID, stat, errCode string) (bool, error) {
	switch p.applyReceipt(ctx, connID, providerID, stat, errCode, true) {
	case receiptRetry:
		return false, fmt.Errorf("dlr: receipt for %s could not be recorded", providerID)
	case receiptUnmatched:
		p.m.DLRReceived.With("unmatched").Inc()
		return false, nil
	case receiptIntermediate:
		return false, nil
	}
	return true, nil
}

type receiptResult int

const (
	receiptDone         receiptResult = iota // recorded (or already final)
	receiptIntermediate                      // not a final status: ignored
	receiptUnmatched                         // no message has this id
	receiptRetry                             // infrastructure error: try again later
)

// applyReceipt records a final receipt for smscID on connID. exact limits
// matching to the id itself (HTTP provider ids), without the hex/decimal
// variants SMPP SMSCs need.
func (p *Processor) applyReceipt(ctx context.Context, connID, smscID, rawStat, rawErr string, exact bool) receiptResult {
	status, final := StatusForStat(rawStat)
	if !final {
		p.m.DLRReceived.With("intermediate").Inc()
		return receiptIntermediate
	}
	p.m.DLRReceived.With(rawStat).Inc()
	msgID, parts, createdMS, found, err := p.lookup(ctx, connID, smscID, exact)
	if err != nil {
		p.log.Warn("dlrmap lookup failed", "connection_id", connID, "smsc_id", smscID, "err", err)
		return receiptRetry
	}
	stat := truncate(rawStat, 7)
	errCode := normalizeErr(rawErr)
	// The receipt's "done date" is in the SMSC's local zone with minute
	// precision and no zone marker; the client sees our own receive time
	// (the same instant recorded as dlr_received_at).
	doneAt := p.opts.Now().UTC()
	if !found {
		return p.fallback(ctx, connID, smscID, status, stat, errCode, exact)
	}
	token := uuid.NewString()
	for _, part := range parts {
		o, err := recordPart(ctx, p.rdb, msgID, part, status, stat, errCode, token, p.opts.Now())
		if err != nil {
			p.log.Warn("record DLR failed", "message_id", msgID, "err", err)
			return receiptRetry
		}
		switch o.Kind {
		case OutcomeFinal:
			if err := p.finalize(ctx, msgID, createdMS, o.Status, o.DLRStat, o.DLRErr, doneAt); err != nil {
				p.log.Error("finalize DLR failed", "message_id", msgID, "err", err)
				if rerr := ReleaseFinal(ctx, p.rdb, msgID); rerr != nil {
					p.log.Warn("release final claim failed", "message_id", msgID, "err", rerr)
				}
				return receiptRetry
			}
			return receiptDone
		case OutcomeNoMsg:
			// Message state expired: update the CDR as a single final outcome.
			p.updateCDR(ctx, msgID, time.UnixMilli(createdMS).UTC(), status, stat, errCode)
			return receiptDone
		case OutcomeDone:
			return receiptDone
		}
	}
	return receiptDone
}

// idForm names how a receipt id relates to the id stored from
// submit_sm_resp on a connection.
type idForm string

const (
	formExact   idForm = "exact"
	formDec2Hex idForm = "dec2hex" // receipt decimal, submit_sm_resp hex
	formHex2Dec idForm = "hex2dec" // receipt hex, submit_sm_resp decimal
)

// idForms returns the normalized key candidates of a receipt id by form.
func idForms(smscID string) map[idForm]string {
	v := pdu.MessageIDVariants(smscID)
	out := map[idForm]string{}
	if len(v) == 0 || v[0] == "" {
		return out
	}
	n := v[0]
	out[formExact] = n
	isDec := true
	for i := 0; i < len(n); i++ {
		if n[i] < '0' || n[i] > '9' {
			isDec = false
			break
		}
	}
	if b, ok := new(big.Int).SetString(n, 10); ok && isDec {
		if h := b.Text(16); h != n {
			out[formDec2Hex] = h
		}
	}
	if b, ok := new(big.Int).SetString(n, 16); ok {
		if d := b.Text(10); d != n {
			out[formHex2Dec] = d
		}
	}
	return out
}

// lookup resolves an SMSC id through dlrmap. It waits (up to LookupWait)
// only for the key in the connection's known id form — the exact id unless
// receipts on this connection were seen to use a converted (hex/decimal)
// form — and tries the other forms once at the end. Polling every variant at
// once would match another message whose id happens to equal this one's
// conversion while this receipt's own entry is still being written.
func (p *Processor) lookup(ctx context.Context, connID, smscID string, exact bool) (msgID string, parts []int, createdMS int64, found bool, err error) {
	forms := idForms(smscID)
	if len(forms) == 0 {
		return "", nil, 0, false, nil
	}
	if exact {
		forms = map[idForm]string{formExact: forms[formExact]}
	}
	primary := formExact
	if f, ok := p.forms.Load(connID); ok {
		if _, has := forms[f.(idForm)]; has {
			primary = f.(idForm)
		}
	}
	parse := func(v string) (string, []int, int64, bool) {
		id, parts, created, perr := pipeline.ParseDLRMapParts(v)
		if perr != nil {
			p.log.Warn("bad dlrmap value", "value", v)
			return "", nil, 0, false
		}
		return id, parts, created, true
	}
	key := pipeline.DLRMapKey(connID, forms[primary])
	deadline := time.Now().Add(p.opts.LookupWait)
	delay := 20 * time.Millisecond
	for {
		v, err := p.rdb.Get(ctx, key).Result()
		if err == nil {
			if id, parts, created, ok := parse(v); ok {
				return id, parts, created, true, nil
			}
			break
		}
		if !errors.Is(err, redis.Nil) {
			return "", nil, 0, false, err
		}
		if time.Now().Add(delay).After(deadline) {
			break
		}
		select {
		case <-time.After(delay):
		case <-ctx.Done():
			return "", nil, 0, false, ctx.Err()
		}
		delay = min(delay*2, 500*time.Millisecond)
	}
	// Other forms, once (exact first).
	for _, f := range []idForm{formExact, formDec2Hex, formHex2Dec} {
		id, ok := forms[f]
		if !ok || f == primary {
			continue
		}
		v, err := p.rdb.Get(ctx, pipeline.DLRMapKey(connID, id)).Result()
		if errors.Is(err, redis.Nil) {
			continue
		}
		if err != nil {
			return "", nil, 0, false, err
		}
		if id, parts, created, ok := parse(v); ok {
			if f != formExact {
				p.forms.Store(connID, f) // this connection converts ids
			} else {
				p.forms.Delete(connID)
			}
			return id, parts, created, true, nil
		}
	}
	return "", nil, 0, false, nil
}

// fallback matches a receipt whose dlrmap entry is gone against
// message_logs.smsc_msg_ids (GIN index) for the last 35 days, preferring a
// row whose stored id is the receipt id itself over a hex/decimal variant
// (exact: the id itself only).
func (p *Processor) fallback(ctx context.Context, connID, smscID, status, stat, errCode string, exact bool) receiptResult {
	if p.db == nil {
		return receiptUnmatched
	}
	raw := strings.TrimSpace(smscID)
	exactIDs := []string{raw, strings.ToLower(raw), strings.ToUpper(raw)}
	cands := append([]string(nil), exactIDs...)
	if !exact {
		forms := idForms(smscID)
		for _, v := range forms {
			cands = append(cands, v, strings.ToUpper(v))
		}
		if n, ok := forms[formExact]; ok {
			exactIDs = append(exactIDs, n, strings.ToUpper(n))
		}
	}
	var id string
	var created time.Time
	err := p.db.QueryRow(ctx, `
		SELECT id::text, created_at FROM message_logs
		 WHERE smsc_msg_ids && $1::text[] AND connection_id = $2
		   AND created_at > now() - interval '35 days'
		 ORDER BY (smsc_msg_ids && $3::text[]) DESC, created_at DESC LIMIT 1`, cands, connID, exactIDs).Scan(&id, &created)
	if errors.Is(err, pgx.ErrNoRows) {
		return receiptUnmatched
	}
	if err != nil {
		p.log.Warn("DLR fallback lookup failed", "err", err)
		return receiptRetry
	}
	p.updateCDR(ctx, id, created, status, stat, errCode)
	return receiptDone
}

// unmatched answers ESME_RX_T_APPN for the first UnmatchedRetries
// deliveries of a receipt nobody knows (counted in Redis for an hour), then
// ESME_ROK so the SMSC stops redelivering it.
func (p *Processor) unmatched(ctx context.Context, connID, smscID string) pdu.CommandStatus {
	key := "dlrunm:" + connID + ":" + pdu.NormalizeMessageID(smscID)
	n, err := p.rdb.Incr(ctx, key).Result()
	if err == nil && n == 1 {
		p.rdb.Expire(ctx, key, time.Hour)
	}
	if err == nil && n <= int64(p.opts.UnmatchedRetries) {
		p.m.DLRReceived.With("unmatched_retry").Inc()
		p.log.Info("unmatched delivery receipt; asking the SMSC to redeliver", "connection_id", connID, "smsc_id", smscID, "attempt", n)
		return pdu.ESME_RX_T_APPN
	}
	p.m.DLRReceived.With("unmatched").Inc()
	p.log.Warn("unmatched delivery receipt", "connection_id", connID, "smsc_id", smscID)
	return pdu.ESME_ROK
}

func (p *Processor) updateCDR(ctx context.Context, msgID string, created time.Time, status, stat, errCode string) {
	now := p.opts.Now().UTC()
	if err := p.sink.Update(ctx, cdr.Update{ID: msgID, CreatedAt: created, Status: status, DLRStat: &stat, DLRErr: &errCode, DLRReceivedAt: &now}); err != nil {
		p.log.Error("cdr update failed", "message_id", msgID, "err", err)
	}
}

// truncate cuts s to at most n bytes without splitting a UTF-8 sequence.
func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	for n > 0 && !utf8.RuneStart(s[n]) {
		n--
	}
	return s[:n]
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

// emit appends the client event for msgID to the DLR stream and marks the
// message emitted.
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
	if err := MarkEmitted(ctx, p.rdb, msgID); err != nil {
		p.log.Warn("could not mark DLR emitted", "message_id", msgID, "err", err)
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
	return p.recordParts(ctx, job, parts, cdr.StatusFailed, errorCode)
}

// PartsUnknown implements dispatch.Finalizer for parts whose submission
// outcome is unknown (they may have been accepted; no receipt can match).
func (p *Processor) PartsUnknown(ctx context.Context, job *pipeline.DispatchJob, parts []int, errorCode string) error {
	return p.recordParts(ctx, job, parts, cdr.StatusUnknown, errorCode)
}

func (p *Processor) recordParts(ctx context.Context, job *pipeline.DispatchJob, parts []int, status, errorCode string) error {
	if err := p.sink.Update(ctx, cdr.Update{ID: job.ID, CreatedAt: job.CreatedAt(), ErrorCode: &errorCode}); err != nil {
		p.log.Error("cdr update failed", "message_id", job.ID, "err", err)
	}
	token := uuid.NewString()
	for _, idx := range parts {
		o, err := recordPart(ctx, p.rdb, job.ID, idx, status, "", "000", token, p.opts.Now())
		if err != nil {
			return err
		}
		if o.Kind == OutcomeFinal {
			if err := p.finalize(ctx, job.ID, job.CreatedMS, o.Status, o.DLRStat, o.DLRErr, p.opts.Now()); err != nil {
				_ = ReleaseFinal(ctx, p.rdb, job.ID)
				return err
			}
			return nil
		}
	}
	return nil
}
