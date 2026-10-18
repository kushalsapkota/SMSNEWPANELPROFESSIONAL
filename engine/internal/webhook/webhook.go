// Package webhook delivers signed event POSTs (CONTRACTS §2 / §9) with
// durable, exponential-backoff retries.
//
// Jobs live in Redis, so pending deliveries survive an engine restart and
// are shared by every engine instance:
//
//	<prefix>due            ZSET  job id -> due time (unix ms)
//	<prefix>job:<id>       HASH  webhook_id, org_id, message_id, event, body, attempt
//	<prefix>sent:<id>      STR   completion marker (dedup of re-enqueues), TTL 72h
//
// A worker claims due jobs atomically by pushing their due time forward by
// a lease (so a crash mid-POST only delays the job by the lease), POSTs,
// and then either deletes the job (2xx, or retries exhausted / webhook
// gone) or reschedules it at now + base·2^(attempt-1). Every attempt is
// logged in webhook_deliveries and updates webhooks.failure_count /
// last_failure_at (failure_count counts consecutive failures; a success
// resets it to 0).
package webhook

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"

	"smsgw/engine/internal/metrics"
	"smsgw/engine/internal/store"
)

// Snapshotter provides the current webhook configuration (*store.Store).
type Snapshotter interface {
	Current() *store.Snapshot
}

// Delivery is one event for one webhook.
type Delivery struct {
	WebhookID string
	OrgID     string
	MessageID string // "" for non-message events
	Event     string // e.g. "dlr"
	Body      []byte // JSON payload (signed as-is)
}

// ID is the job id: one job per (webhook, event, message).
func (d Delivery) ID() string { return d.WebhookID + ":" + d.Event + ":" + d.MessageID }

// Options tune a Queue.
type Options struct {
	KeyPrefix    string        // default "wh:"
	Workers      int           // concurrent POSTs; default 16
	Timeout      time.Duration // per POST; default 10s
	BaseBackoff  time.Duration // first retry delay; default 10s (CONTRACTS: 10s·2^n)
	MaxBackoff   time.Duration // cap; default 6h
	PollInterval time.Duration // due-job polling; default 500ms
	DedupTTL     time.Duration // completion marker lifetime; default 72h
	UserAgent    string        // default "smsgw-webhook/1"
	HTTPClient   *http.Client  // default: Timeout, no redirects
	Logger       *slog.Logger
	Metrics      *metrics.Engine
	Now          func() time.Time
}

// Queue enqueues and delivers webhook jobs.
type Queue struct {
	rdb  redis.UniversalClient
	db   *pgxpool.Pool
	src  Snapshotter
	opts Options
	hc   *http.Client
	log  *slog.Logger
	m    *metrics.Engine
}

// New creates a Queue. db may be nil (attempts are then not logged).
func New(rdb redis.UniversalClient, db *pgxpool.Pool, src Snapshotter, o Options) *Queue {
	if o.KeyPrefix == "" {
		o.KeyPrefix = "wh:"
	}
	if o.Workers <= 0 {
		o.Workers = 16
	}
	if o.Timeout <= 0 {
		o.Timeout = 10 * time.Second
	}
	if o.BaseBackoff <= 0 {
		o.BaseBackoff = 10 * time.Second
	}
	if o.MaxBackoff <= 0 {
		o.MaxBackoff = 6 * time.Hour
	}
	if o.PollInterval <= 0 {
		o.PollInterval = 500 * time.Millisecond
	}
	if o.DedupTTL <= 0 {
		o.DedupTTL = 72 * time.Hour
	}
	if o.UserAgent == "" {
		o.UserAgent = "smsgw-webhook/1"
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
	hc := o.HTTPClient
	if hc == nil {
		hc = &http.Client{
			Timeout: o.Timeout,
			// A redirect is a failed delivery: the signature is bound to the
			// configured URL and secrets must not follow redirects.
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		}
	}
	return &Queue{rdb: rdb, db: db, src: src, opts: o, hc: hc, log: o.Logger.With("component", "webhook"), m: o.Metrics}
}

func (q *Queue) dueKey() string           { return q.opts.KeyPrefix + "due" }
func (q *Queue) jobKey(id string) string  { return q.opts.KeyPrefix + "job:" + id }
func (q *Queue) sentKey(id string) string { return q.opts.KeyPrefix + "sent:" + id }

// enqueueSrc: KEYS job, sent, due; ARGV id, now_ms, webhook, org, message, event, body.
var enqueueScript = redis.NewScript(`
if redis.call('EXISTS', KEYS[1]) == 1 or redis.call('EXISTS', KEYS[2]) == 1 then return 0 end
redis.call('HSET', KEYS[1], 'webhook_id', ARGV[3], 'org_id', ARGV[4], 'message_id', ARGV[5],
  'event', ARGV[6], 'body', ARGV[7], 'attempt', 0, 'created_ms', ARGV[2])
redis.call('ZADD', KEYS[3], ARGV[2], ARGV[1])
return 1`)

// claimSrc: KEYS due; ARGV now_ms, lease_ms, limit.
var claimScript = redis.NewScript(`
local ids = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, tonumber(ARGV[3]))
local until_ms = tonumber(ARGV[1]) + tonumber(ARGV[2])
for _, id in ipairs(ids) do redis.call('ZADD', KEYS[1], until_ms, id) end
return ids`)

// Enqueue schedules d for immediate delivery. It is idempotent: a job that
// is pending, or completed within DedupTTL, is not enqueued again.
func (q *Queue) Enqueue(ctx context.Context, d Delivery) error {
	if d.WebhookID == "" || d.Event == "" || len(d.Body) == 0 {
		return errors.New("webhook: webhook id, event and body are required")
	}
	id := d.ID()
	err := enqueueScript.Run(ctx, q.rdb, []string{q.jobKey(id), q.sentKey(id), q.dueKey()},
		id, q.opts.Now().UnixMilli(), d.WebhookID, d.OrgID, d.MessageID, d.Event, string(d.Body)).Err()
	if err != nil && !errors.Is(err, redis.Nil) {
		return fmt.Errorf("webhook: enqueue: %w", err)
	}
	return nil
}

// Pending returns the number of queued jobs (due or scheduled).
func (q *Queue) Pending(ctx context.Context) (int64, error) {
	return q.rdb.ZCard(ctx, q.dueKey()).Result()
}

// Run delivers jobs until ctx is cancelled; in-flight POSTs are allowed to
// finish (bounded by Timeout).
func (q *Queue) Run(ctx context.Context) {
	sem := make(chan struct{}, q.opts.Workers)
	var wg sync.WaitGroup
	defer wg.Wait()
	t := time.NewTicker(q.opts.PollInterval)
	defer t.Stop()
	for {
		free := cap(sem) - len(sem)
		if free > 0 {
			ids, err := q.claim(ctx, free)
			if err != nil && ctx.Err() == nil {
				q.log.Warn("claim webhook jobs failed", "err", err)
			}
			for _, id := range ids {
				sem <- struct{}{}
				wg.Add(1)
				go func(id string) {
					defer func() { <-sem; wg.Done() }()
					q.deliver(context.WithoutCancel(ctx), id)
				}(id)
			}
			if len(ids) == free {
				continue // more may be due right now
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

func (q *Queue) claim(ctx context.Context, n int) ([]string, error) {
	lease := (q.opts.Timeout + 30*time.Second).Milliseconds()
	return claimScript.Run(ctx, q.rdb, []string{q.dueKey()}, q.opts.Now().UnixMilli(), lease, n).StringSlice()
}

func (q *Queue) finish(ctx context.Context, id string) {
	_, err := q.rdb.TxPipelined(ctx, func(p redis.Pipeliner) error {
		p.ZRem(ctx, q.dueKey(), id)
		p.Del(ctx, q.jobKey(id))
		p.Set(ctx, q.sentKey(id), "1", q.opts.DedupTTL)
		return nil
	})
	if err != nil {
		q.log.Warn("finish webhook job failed", "job", id, "err", err)
	}
}

// Backoff returns the delay after attempt n (1-based): base·2^(n-1), capped.
func (q *Queue) Backoff(n int) time.Duration {
	d := q.opts.BaseBackoff
	for i := 1; i < n; i++ {
		d *= 2
		if d >= q.opts.MaxBackoff {
			return q.opts.MaxBackoff
		}
	}
	return min(d, q.opts.MaxBackoff)
}

// Sign returns the X-Webhook-Signature value for body at ts (CONTRACTS §2).
func Sign(secret string, ts int64, body []byte) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(strconv.FormatInt(ts, 10)))
	mac.Write([]byte{'.'})
	mac.Write(body)
	return "sha256=" + hex.EncodeToString(mac.Sum(nil))
}

// Verify checks a signature header (for receivers and tests).
func Verify(secret, timestamp, signature string, body []byte) bool {
	ts, err := strconv.ParseInt(timestamp, 10, 64)
	if err != nil {
		return false
	}
	return hmac.Equal([]byte(Sign(secret, ts, body)), []byte(signature))
}

func (q *Queue) deliver(ctx context.Context, id string) {
	vals, err := q.rdb.HGetAll(ctx, q.jobKey(id)).Result()
	if err != nil {
		q.log.Warn("load webhook job failed", "job", id, "err", err)
		return // lease expires; retried later
	}
	if len(vals) == 0 {
		q.rdb.ZRem(ctx, q.dueKey(), id) // job body gone (finished elsewhere)
		return
	}
	whID, orgID, msgID, event := vals["webhook_id"], vals["org_id"], vals["message_id"], vals["event"]
	body := []byte(vals["body"])
	attempt, _ := strconv.Atoi(vals["attempt"])
	attempt++

	var wh *store.Webhook
	if snap := q.src.Current(); snap != nil {
		for _, w := range snap.Webhooks(orgID) {
			if w.ID == whID {
				wh = w
				break
			}
		}
	}
	if wh == nil || !wh.Enabled || wh.SecretErr != nil || !wh.Subscribed(event) {
		q.log.Info("dropping webhook job: webhook deleted, disabled or unsubscribed", "job", id, "webhook_id", whID)
		q.finish(ctx, id)
		return
	}

	status, dur, perr := q.post(ctx, wh, event, id, body)
	ok := perr == nil && status >= 200 && status < 300
	errText := ""
	switch {
	case perr != nil:
		errText = perr.Error()
	case !ok:
		errText = fmt.Sprintf("HTTP %d", status)
	}
	q.record(ctx, wh, orgID, msgID, attempt, status, errText, dur, ok)

	if ok {
		q.m.WebhookAttempts.With("ok").Inc()
		q.finish(ctx, id)
		return
	}
	q.m.WebhookAttempts.With("error").Inc()
	if attempt > wh.MaxRetries {
		q.log.Warn("webhook delivery failed permanently", "job", id, "webhook_id", whID, "attempts", attempt, "err", errText)
		q.finish(ctx, id)
		return
	}
	next := q.opts.Now().Add(q.Backoff(attempt))
	_, err = q.rdb.TxPipelined(ctx, func(p redis.Pipeliner) error {
		p.HSet(ctx, q.jobKey(id), "attempt", attempt)
		p.ZAdd(ctx, q.dueKey(), redis.Z{Score: float64(next.UnixMilli()), Member: id})
		return nil
	})
	if err != nil {
		q.log.Warn("reschedule webhook job failed (lease will retry it)", "job", id, "err", err)
	}
	q.log.Info("webhook delivery failed; will retry", "job", id, "attempt", attempt, "next", next, "err", errText)
}

func (q *Queue) post(ctx context.Context, wh *store.Webhook, event, id string, body []byte) (int, time.Duration, error) {
	ctx, cancel := context.WithTimeout(ctx, q.opts.Timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, wh.URL, bytes.NewReader(body))
	if err != nil {
		return 0, 0, err
	}
	ts := q.opts.Now().Unix()
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", q.opts.UserAgent)
	req.Header.Set("X-Webhook-Timestamp", strconv.FormatInt(ts, 10))
	req.Header.Set("X-Webhook-Signature", Sign(wh.Secret, ts, body))
	req.Header.Set("X-Webhook-Event", event)
	req.Header.Set("X-Webhook-Delivery", id)
	start := time.Now()
	resp, err := q.hc.Do(req)
	dur := time.Since(start)
	q.m.WebhookLatency.Observe(dur.Seconds())
	if err != nil {
		return 0, dur, err
	}
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
	resp.Body.Close()
	return resp.StatusCode, dur, nil
}

func (q *Queue) record(ctx context.Context, wh *store.Webhook, orgID, msgID string, attempt, status int, errText string, dur time.Duration, ok bool) {
	if q.db == nil {
		return
	}
	var code any
	if status > 0 {
		code = int16(status)
	}
	var e any
	if errText != "" {
		if len(errText) > 1000 {
			errText = errText[:1000]
		}
		e = errText
	}
	var mid any
	if msgID != "" {
		mid = msgID
	}
	if _, err := q.db.Exec(ctx, `
		INSERT INTO webhook_deliveries (webhook_id, org_id, message_id, attempt, status_code, error, duration_ms)
		VALUES ($1, $2, $3, $4, $5, $6, $7)`,
		wh.ID, orgID, mid, int16(min(attempt, 32767)), code, e, int32(dur.Milliseconds())); err != nil {
		q.log.Warn("log webhook delivery failed", "webhook_id", wh.ID, "err", err)
	}
	var err error
	if ok {
		_, err = q.db.Exec(ctx, `UPDATE webhooks SET failure_count = 0 WHERE id = $1 AND failure_count <> 0`, wh.ID)
	} else {
		_, err = q.db.Exec(ctx, `UPDATE webhooks SET failure_count = failure_count + 1, last_failure_at = now() WHERE id = $1`, wh.ID)
	}
	if err != nil {
		q.log.Warn("update webhook failure stats failed", "webhook_id", wh.ID, "err", err)
	}
}
