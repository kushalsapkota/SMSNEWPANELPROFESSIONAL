package pipeline

import (
	"context"
	"encoding/json"
	"log/slog"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"

	"smsgw/engine/internal/billing"
	"smsgw/engine/internal/cdr"
	"smsgw/engine/internal/metrics"
)

// RefundPendingKey is the Redis list of refunds that could not be applied
// yet (JSON PendingRefund); every engine instance's Refunder retries them.
const RefundPendingKey = "refund:pending"

// PendingRefund is a refund waiting to be retried.
type PendingRefund struct {
	MsgID   string  `json:"id"`
	Tag     string  `json:"tag"`
	Legs    []Leg   `json:"legs"`
	Amounts []int64 `json:"amts,omitempty"`
	Reason  string  `json:"reason"`
	Queued  int64   `json:"queued_ms"`
	// CDR is applied once the refund succeeds (e.g. refunded=true, or the
	// reduced costs of a partial refund).
	CDR *cdr.Update `json:"cdr,omitempty"`
}

// RefundOutcome classifies a refund attempt.
type RefundOutcome int

const (
	// RefundApplied: the money is back (refunded now, already refunded
	// earlier, or credited through the ledger).
	RefundApplied RefundOutcome = iota
	// RefundNothing: there was no debit to refund (unknown / expired txn).
	RefundNothing
	// RefundQueued: a transient failure; the refund was queued for retry.
	RefundQueued
)

// Refunder applies refunds and retries the ones that fail transiently, so a
// Redis or database blip never silently keeps a customer charged for a
// message the CDR shows as refunded.
type Refunder struct {
	biller Biller
	rdb    redis.UniversalClient
	sink   CDRSink
	log    *slog.Logger
	m      *metrics.Engine
	key    string
	maxAge time.Duration

	mu  sync.Mutex
	mem []PendingRefund // could not even be queued in Redis
}

// RefunderOptions tune a Refunder.
type RefunderOptions struct {
	Key     string        // default RefundPendingKey
	MaxAge  time.Duration // give up after (the debit record's lifetime); default 72h
	Logger  *slog.Logger
	Metrics *metrics.Engine
}

// NewRefunder creates a Refunder. sink may be nil (no CDR follow-up).
func NewRefunder(b Biller, rdb redis.UniversalClient, sink CDRSink, o RefunderOptions) *Refunder {
	if o.Key == "" {
		o.Key = RefundPendingKey
	}
	if o.MaxAge <= 0 {
		o.MaxAge = 72 * time.Hour
	}
	if o.Logger == nil {
		o.Logger = slog.Default()
	}
	return &Refunder{biller: b, rdb: rdb, sink: sink, log: o.Logger.With("component", "refunder"), m: o.Metrics,
		key: o.Key, maxAge: o.MaxAge}
}

// Refund refunds a message debit (amounts nil = everything not yet
// refunded; otherwise one cap per leg). onApplied (optional) is the CDR
// update to write if the refund only succeeds on a later retry; when the
// result is RefundApplied the caller writes its own CDR update.
func (r *Refunder) Refund(ctx context.Context, msgID, tag string, legs []Leg, amounts []int64, reason string, onApplied *cdr.Update) RefundOutcome {
	if len(legs) == 0 || tag == "" {
		return RefundNothing
	}
	pr := PendingRefund{MsgID: msgID, Tag: tag, Legs: legs, Amounts: amounts, Reason: reason, Queued: time.Now().UnixMilli(), CDR: onApplied}
	out, err := r.apply(ctx, pr)
	if err == nil {
		return out
	}
	r.log.Error("refund failed; queued for retry", "message_id", msgID, "reason", reason, "err", err)
	r.queue(ctx, pr)
	return RefundQueued
}

// apply runs one refund attempt: refund.lua (hydrating once), and the
// locked ledger path when the balance is still not loaded.
func (r *Refunder) apply(ctx context.Context, pr PendingRefund) (RefundOutcome, error) {
	bl := toBillingLegs(pr.Tag, pr.Legs)
	res, err := r.biller.Refund(ctx, pr.MsgID, bl, pr.Amounts)
	if err != nil {
		return RefundQueued, err
	}
	if res.Status == billing.StatusNotLoaded {
		if res, err = r.biller.RefundUnloaded(ctx, pr.MsgID, bl, pr.Amounts); err != nil {
			return RefundQueued, err
		}
	}
	switch res.Status {
	case billing.StatusOK, billing.StatusNothingToRefund:
		if r.m != nil {
			r.m.Refunds.With(pr.Reason).Inc()
		}
		return RefundApplied, nil
	case billing.StatusNoTxn:
		r.log.Warn("refund: debit record unknown or expired; nothing refunded", "message_id", pr.MsgID, "reason", pr.Reason)
		return RefundNothing, nil
	}
	r.log.Error("refund: unexpected status", "message_id", pr.MsgID, "status", res.Status)
	return RefundNothing, nil
}

func (r *Refunder) queue(ctx context.Context, pr PendingRefund) {
	b, err := json.Marshal(pr)
	if err == nil {
		qctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 3*time.Second)
		err = r.rdb.RPush(qctx, r.key, b).Err()
		cancel()
	}
	if err != nil {
		r.log.Error("cannot persist pending refund; keeping it in memory", "message_id", pr.MsgID, "err", err)
		r.mu.Lock()
		r.mem = append(r.mem, pr)
		r.mu.Unlock()
	}
}

// Run retries pending refunds every interval until ctx is cancelled.
func (r *Refunder) Run(ctx context.Context, interval time.Duration) {
	if interval <= 0 {
		interval = 10 * time.Second
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			r.RetryPending(ctx)
		}
	}
}

// RetryPending makes one pass over the pending refunds (in-memory ones
// first, then up to 500 from Redis). Entries are removed once applied, found
// to be moot, or older than MaxAge. Several instances may retry the same
// entry concurrently: a short per-message lock prevents double partial
// refunds (full refunds are idempotent in refund.lua anyway).
func (r *Refunder) RetryPending(ctx context.Context) {
	r.mu.Lock()
	mem := r.mem
	r.mem = nil
	r.mu.Unlock()
	for _, pr := range mem {
		if ctx.Err() != nil {
			r.mu.Lock()
			r.mem = append(r.mem, pr)
			r.mu.Unlock()
			continue
		}
		if !r.retry(ctx, pr) {
			r.queue(ctx, pr)
		}
	}
	items, err := r.rdb.LRange(ctx, r.key, 0, 499).Result()
	if err != nil {
		if ctx.Err() == nil {
			r.log.Warn("read pending refunds failed", "err", err)
		}
		return
	}
	for _, raw := range items {
		if ctx.Err() != nil {
			return
		}
		var pr PendingRefund
		if err := json.Unmarshal([]byte(raw), &pr); err != nil {
			r.log.Error("dropping malformed pending refund", "value", raw)
			r.rdb.LRem(ctx, r.key, 1, raw)
			continue
		}
		lock := "refund:lock:" + pr.MsgID
		ok, err := r.rdb.SetNX(ctx, lock, 1, time.Minute).Result()
		if err != nil || !ok {
			continue
		}
		done := r.retry(ctx, pr)
		if done {
			r.rdb.LRem(ctx, r.key, 1, raw)
		}
		r.rdb.Del(ctx, lock)
	}
}

// retry reports whether pr is finished (applied, moot or expired).
func (r *Refunder) retry(ctx context.Context, pr PendingRefund) bool {
	if time.Since(time.UnixMilli(pr.Queued)) > r.maxAge {
		r.log.Error("giving up on refund", "message_id", pr.MsgID, "reason", pr.Reason)
		return true
	}
	out, err := r.apply(ctx, pr)
	if err != nil {
		r.log.Warn("refund retry failed", "message_id", pr.MsgID, "err", err)
		return false
	}
	if out == RefundApplied {
		r.log.Info("pending refund applied", "message_id", pr.MsgID, "reason", pr.Reason)
		if pr.CDR != nil && r.sink != nil {
			if err := r.sink.Update(ctx, *pr.CDR); err != nil {
				r.log.Error("cdr update after refund failed", "message_id", pr.MsgID, "err", err)
			}
		}
	}
	return true
}

// Pending reports the number of refunds waiting in memory (Redis-queued
// ones are not counted).
func (r *Refunder) Pending() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.mem)
}
