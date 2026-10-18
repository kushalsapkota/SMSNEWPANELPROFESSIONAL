// Package cdr is the engine's asynchronous, batched writer for message_logs
// (CDRs) and the hourly rollups in message_stats_hourly.
//
// Producers call Insert (one row per accepted message) and Update (status /
// DLR / submission changes). Operations are queued in memory, in order, and
// written in batches (every FlushInterval or BatchSize operations) inside a
// single transaction per batch:
//
//  1. inserts (INSERT ... ON CONFLICT (id, created_at) DO NOTHING);
//  2. updates: the target rows are locked (SELECT ... FOR UPDATE, by the
//     partition key id+created_at so only one partition is touched), the
//     new values are computed against the locked row and written back;
//  3. rollup deltas are upserted into message_stats_hourly.
//
// Rollups are maintained from the *difference* between the locked old row
// and the new row, so a status that changes (ACCEPTED → SUBMITTED →
// DELIVERED) moves a message between counters instead of being counted
// twice, and a replayed/duplicate operation contributes nothing.
//
// Status changes are monotonic by rank (ACCEPTED < QUEUED < SUBMITTED <
// final): a late SUBMITTED never overwrites DELIVERED; other fields of that
// update (smsc ids, submitted_at, connection) are still applied.
//
// An update whose row does not exist yet (inserted by another engine
// instance whose batch has not committed) is retried for UnmatchedRetry
// before being dropped.
package cdr

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"smsgw/engine/internal/metrics"
	"smsgw/engine/internal/phone"
)

// Message statuses (msg_status enum).
const (
	StatusAccepted    = "ACCEPTED"
	StatusQueued      = "QUEUED"
	StatusSubmitted   = "SUBMITTED"
	StatusDelivered   = "DELIVERED"
	StatusUndelivered = "UNDELIVERED"
	StatusFailed      = "FAILED"
	StatusExpired     = "EXPIRED"
	StatusRejected    = "REJECTED"
	StatusUnknown     = "UNKNOWN"
)

// Rank orders statuses: transitions only move to a higher rank.
func Rank(status string) int {
	switch status {
	case StatusAccepted:
		return 0
	case StatusQueued:
		return 1
	case StatusSubmitted:
		return 2
	case StatusDelivered, StatusUndelivered, StatusFailed, StatusExpired, StatusRejected, StatusUnknown:
		return 3
	}
	return -1
}

// IsFinal reports whether status is final.
func IsFinal(status string) bool { return Rank(status) == 3 }

// Record is one message_logs row to insert. Empty strings for nullable uuid
// / text columns are written as NULL; nil pointers are NULL.
type Record struct {
	ID        string
	CreatedAt time.Time // must be the exact value later updates use (ms precision recommended)

	OrgID        string
	ResellerID   string
	RouteID      string
	ConnectionID string
	TemplateID   string
	CampaignID   string

	Channel      string
	ClientMsgRef string

	SourceAddr      string
	SourceTON       int
	SourceNPI       int
	DestinationAddr string
	DestTON         int
	DestNPI         int
	CountryISO      string // "" = derived from DestinationAddr

	OrigText     string
	SentText     string
	OTPExtracted *bool
	Encoding     string // GSM7 | UCS2
	Parts        int

	Status    string // default ACCEPTED
	ErrorCode string

	ClientRateMicros   *int64
	ClientCostMicros   *int64
	ResellerCostMicros *int64
	RouteCostMicros    *int64
	Refunded           bool
	SubmittedAt        *time.Time
}

// Update changes an existing row. Zero / nil fields are left unchanged.
type Update struct {
	ID        string
	CreatedAt time.Time

	Status       string
	ConnectionID string
	SMSCMsgIDs   []string // replaces the array when non-nil
	ErrorCode    *string
	DLRStat      *string
	DLRErr       *string

	RouteCostMicros    *int64
	ClientCostMicros   *int64 // e.g. reduced after a partial refund
	ResellerCostMicros *int64
	Refunded           *bool
	SubmittedAt        *time.Time
	DLRReceivedAt      *time.Time
}

// Options tune a Writer.
type Options struct {
	FlushInterval  time.Duration // default 250ms
	BatchSize      int           // default 500
	QueueSize      int           // buffered operations; default 20000
	UnmatchedRetry time.Duration // how long updates for missing rows are retried; default 30s
	Logger         *slog.Logger
	Metrics        *metrics.Engine // optional
}

// DB is what the writer needs from *pgxpool.Pool.
type DB interface {
	BeginTx(ctx context.Context, opts pgx.TxOptions) (pgx.Tx, error)
}

type op struct {
	ins   *Record
	upd   *Update
	flush chan error // flush request marker
	first time.Time  // first attempt (updates)
}

// Writer batches CDR writes. Create with New, run Run, call Close (or
// cancel Run's context) to drain.
type Writer struct {
	db   DB
	opts Options
	log  *slog.Logger
	m    *metrics.Engine

	ch      chan op
	closeMu sync.RWMutex
	closed  bool
	stop    chan struct{}
	done    chan struct{}
	started chan struct{}
	once    sync.Once
}

// ErrClosed is returned when writing to a closed Writer.
var ErrClosed = errors.New("cdr: writer closed")

// New creates a Writer.
func New(db DB, o Options) *Writer {
	if o.FlushInterval <= 0 {
		o.FlushInterval = 250 * time.Millisecond
	}
	if o.BatchSize <= 0 {
		o.BatchSize = 500
	}
	if o.QueueSize <= 0 {
		o.QueueSize = 20000
	}
	if o.UnmatchedRetry <= 0 {
		o.UnmatchedRetry = 30 * time.Second
	}
	if o.Logger == nil {
		o.Logger = slog.Default()
	}
	return &Writer{db: db, opts: o, log: o.Logger.With("component", "cdr"), m: o.Metrics,
		ch: make(chan op, o.QueueSize), stop: make(chan struct{}), done: make(chan struct{}), started: make(chan struct{})}
}

// QueueLen is the number of buffered operations.
func (w *Writer) QueueLen() int { return len(w.ch) }

func (w *Writer) enqueue(ctx context.Context, o op) error {
	w.closeMu.RLock()
	defer w.closeMu.RUnlock()
	if w.closed {
		return ErrClosed
	}
	select {
	case w.ch <- o:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Insert queues a new row. It blocks (bounded by ctx) when the queue is full.
func (w *Writer) Insert(ctx context.Context, r Record) error {
	if r.ID == "" || r.CreatedAt.IsZero() || r.OrgID == "" || r.Channel == "" || r.DestinationAddr == "" {
		return fmt.Errorf("cdr: insert: id, created_at, org_id, channel and destination are required")
	}
	if r.Status == "" {
		r.Status = StatusAccepted
	}
	if r.Encoding == "" {
		r.Encoding = "GSM7"
	}
	if r.Parts <= 0 {
		r.Parts = 1
	}
	if r.CountryISO == "" {
		r.CountryISO = phone.CountryCode(r.DestinationAddr)
	}
	return w.enqueue(ctx, op{ins: &r})
}

// Update queues a change.
func (w *Writer) Update(ctx context.Context, u Update) error {
	if u.ID == "" || u.CreatedAt.IsZero() {
		return fmt.Errorf("cdr: update: id and created_at are required")
	}
	if u.Status != "" && Rank(u.Status) < 0 {
		return fmt.Errorf("cdr: update: invalid status %q", u.Status)
	}
	return w.enqueue(ctx, op{upd: &u})
}

// Flush blocks until every operation queued before the call has been
// attempted (written, or scheduled for retry).
func (w *Writer) Flush(ctx context.Context) error {
	ch := make(chan error, 1)
	if err := w.enqueue(ctx, op{flush: ch}); err != nil {
		return err
	}
	select {
	case err := <-ch:
		return err
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Close stops accepting operations, writes everything still queued and
// waits for Run to return (bounded by ctx).
func (w *Writer) Close(ctx context.Context) error {
	w.closeMu.Lock()
	if !w.closed {
		w.closed = true
		close(w.ch)
		close(w.stop)
	}
	w.closeMu.Unlock()
	select {
	case <-w.started:
	default:
		// Run never started: drain synchronously.
		w.once.Do(func() { close(w.started); go w.loop(context.Background()) })
	}
	select {
	case <-w.done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Run processes operations until Close. Cancelling ctx aborts in-flight
// database work; prefer Close for a graceful drain.
func (w *Writer) Run(ctx context.Context) {
	w.once.Do(func() { close(w.started); w.loop(ctx) })
	<-w.done
}

func (w *Writer) loop(ctx context.Context) {
	defer close(w.done)
	var (
		batch   []op
		retry   []op // unmatched updates, or everything during a database outage
		flushes []chan error
		backoff time.Duration
	)
	timer := time.NewTimer(w.opts.FlushInterval)
	defer timer.Stop()
	flush := func() {
		var err error
		if len(batch) > 0 || len(retry) > 0 {
			all := append(retry, batch...)
			var outage bool
			retry, outage = w.write(ctx, all)
			batch = nil
			if outage {
				backoff = min(max(2*backoff, 100*time.Millisecond), 5*time.Second)
				err = errOutage
			} else {
				backoff = 0
			}
		}
		for _, f := range flushes {
			f <- err
		}
		flushes = nil
	}
	add := func(o op) {
		if o.flush != nil {
			flushes = append(flushes, o.flush)
			flush()
			return
		}
		batch = append(batch, o)
		if len(batch) >= w.opts.BatchSize && backoff == 0 {
			flush()
		}
	}
	for {
		in := w.ch
		if len(retry)+len(batch) >= w.opts.QueueSize {
			in = nil // database outage: stop draining so producers feel back-pressure
		}
		select {
		case o, ok := <-in:
			if ok {
				add(o)
				continue
			}
		case <-w.stop:
		case <-timer.C:
			flush()
			timer.Reset(w.opts.FlushInterval + backoff)
			continue
		}
		// Closing: take everything still queued, then write it.
		for o := range w.ch {
			if o.flush != nil {
				flushes = append(flushes, o.flush)
				continue
			}
			batch = append(batch, o)
		}
		flush()
		if len(retry) > 0 {
			// One last attempt (rows inserted by another instance meanwhile).
			retry, _ = w.write(ctx, retry)
			for _, o := range retry {
				kind := "update"
				if o.ins != nil {
					kind = "insert"
				}
				w.count(w.dropped(), kind)
			}
			if len(retry) > 0 {
				w.log.Error("CDR operations lost at shutdown", "count", len(retry))
			}
		}
		return
	}
}

var errOutage = errors.New("cdr: database unavailable; operations kept queued")

func (w *Writer) dropped() *metrics.Counter {
	if w.m == nil {
		return nil
	}
	return w.m.CDRDropped
}

func (w *Writer) count(c *metrics.Counter, label string) {
	if c != nil {
		c.With(label).Inc()
	}
}

// write applies ops. It returns the operations to try again: updates whose
// row does not exist yet (within UnmatchedRetry) and — when the database is
// unreachable (outage=true) — every operation not yet written. Operations
// the database rejects (data errors) are isolated and dropped one by one.
func (w *Writer) write(ctx context.Context, ops []op) (retry []op, outage bool) {
	unmatched, err := w.writeBatch(ctx, ops)
	if err == nil {
		return w.keepRetrying(unmatched), false
	}
	if !isDataError(err) {
		if w.m != nil {
			w.m.CDRErrors.With("batch").Inc()
		}
		if ctx.Err() == nil {
			w.log.Warn("CDR write failed; keeping operations queued", "ops", len(ops), "err", err)
		}
		return ops, true
	}
	w.log.Error("CDR batch rejected by the database; writing operations one by one", "ops", len(ops), "err", err)
	var keep []op
	for i, o := range ops {
		um, err := w.writeBatch(ctx, []op{o})
		if err != nil {
			if !isDataError(err) {
				return append(keep, ops[i:]...), true
			}
			kind := "update"
			if o.ins != nil {
				kind = "insert"
			}
			if w.m != nil {
				w.m.CDRErrors.With(kind).Inc()
				w.m.CDRDropped.With(kind).Inc()
			}
			w.log.Error("dropping CDR operation", "op", kind, "id", opID(o), "err", err)
			continue
		}
		keep = append(keep, w.keepRetrying(um)...)
	}
	return keep, false
}

// isDataError reports whether err is a definitive rejection of the data by
// Postgres (constraint, type, ...) as opposed to a transient condition
// (connection loss, resources, operator intervention, serialization /
// deadlock, lock timeout) after which the same batch may succeed.
func isDataError(err error) bool {
	var pg *pgconn.PgError
	if !errors.As(err, &pg) || len(pg.Code) < 2 {
		return false
	}
	switch pg.Code[:2] {
	case "08", "40", "53", "55", "57", "58", "XX":
		return false
	}
	return true
}

func opID(o op) string {
	if o.ins != nil {
		return o.ins.ID
	}
	if o.upd != nil {
		return o.upd.ID
	}
	return ""
}

func (w *Writer) keepRetrying(unmatched []op) []op {
	now := time.Now()
	out := unmatched[:0]
	for _, o := range unmatched {
		if o.first.IsZero() {
			o.first = now
		}
		if now.Sub(o.first) > w.opts.UnmatchedRetry {
			if w.m != nil {
				w.m.CDRDropped.With("update").Inc()
			}
			w.log.Warn("dropping CDR update for unknown message", "id", o.upd.ID, "created_at", o.upd.CreatedAt)
			continue
		}
		out = append(out, o)
	}
	return out
}

type rowKey struct {
	id string
	at int64 // unix micros
}

func keyOf(id string, t time.Time) rowKey { return rowKey{id, t.UnixMicro()} }

// merged is the combination of all updates for one row in a batch.
type merged struct {
	u   Update
	ops []op
}

func mergeUpdate(dst *Update, src *Update) {
	// Highest rank wins; between two finals the first one is kept (the
	// same rule apply uses against the stored row).
	if src.Status != "" && Rank(src.Status) > Rank(dst.Status) {
		dst.Status = src.Status
	}
	if src.ConnectionID != "" {
		dst.ConnectionID = src.ConnectionID
	}
	if src.SMSCMsgIDs != nil {
		dst.SMSCMsgIDs = src.SMSCMsgIDs
	}
	if src.ErrorCode != nil {
		dst.ErrorCode = src.ErrorCode
	}
	if src.DLRStat != nil {
		dst.DLRStat = src.DLRStat
	}
	if src.DLRErr != nil {
		dst.DLRErr = src.DLRErr
	}
	if src.RouteCostMicros != nil {
		dst.RouteCostMicros = src.RouteCostMicros
	}
	if src.ClientCostMicros != nil {
		dst.ClientCostMicros = src.ClientCostMicros
	}
	if src.ResellerCostMicros != nil {
		dst.ResellerCostMicros = src.ResellerCostMicros
	}
	if src.Refunded != nil && (dst.Refunded == nil || *src.Refunded) {
		dst.Refunded = src.Refunded
	}
	if src.SubmittedAt != nil {
		dst.SubmittedAt = src.SubmittedAt
	}
	if src.DLRReceivedAt != nil {
		dst.DLRReceivedAt = src.DLRReceivedAt
	}
}

func (w *Writer) writeBatch(ctx context.Context, ops []op) (unmatched []op, err error) {
	var inserts []*Record
	updates := map[rowKey]*merged{}
	var updOrder []rowKey
	for _, o := range ops {
		switch {
		case o.ins != nil:
			inserts = append(inserts, o.ins)
		case o.upd != nil:
			k := keyOf(o.upd.ID, o.upd.CreatedAt)
			m := updates[k]
			if m == nil {
				m = &merged{u: Update{ID: o.upd.ID, CreatedAt: o.upd.CreatedAt}}
				updates[k] = m
				updOrder = append(updOrder, k)
			}
			mergeUpdate(&m.u, o.upd)
			m.ops = append(m.ops, o)
		}
	}

	tx, err := w.db.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, fmt.Errorf("cdr: begin: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck // no-op after commit

	roll := rollups{}
	nIns := 0
	if len(inserts) > 0 {
		b := &pgx.Batch{}
		for _, r := range inserts {
			b.Queue(insertSQL, insertArgs(r)...)
		}
		br := tx.SendBatch(ctx, b)
		for _, r := range inserts {
			tag, err := br.Exec()
			if err != nil {
				br.Close()
				return nil, fmt.Errorf("cdr: insert %s: %w", r.ID, err)
			}
			if tag.RowsAffected() == 1 {
				nIns++
				roll.addInsert(r)
			}
		}
		if err := br.Close(); err != nil {
			return nil, fmt.Errorf("cdr: insert batch: %w", err)
		}
	}

	nUpd := 0
	if len(updates) > 0 {
		sort.Slice(updOrder, func(i, j int) bool { // stable lock order across instances
			if updOrder[i].id != updOrder[j].id {
				return updOrder[i].id < updOrder[j].id
			}
			return updOrder[i].at < updOrder[j].at
		})
		ids := make([]string, len(updOrder))
		ats := make([]time.Time, len(updOrder))
		for i, k := range updOrder {
			ids[i] = k.id
			ats[i] = updates[k].u.CreatedAt
		}
		old, err := lockRows(ctx, tx, ids, ats)
		if err != nil {
			return nil, err
		}
		b := &pgx.Batch{}
		var applied []rowKey
		for _, k := range updOrder {
			m := updates[k]
			cur, ok := old[k]
			if !ok {
				unmatched = append(unmatched, m.ops...)
				continue
			}
			next := apply(cur, &m.u)
			roll.addChange(cur, next)
			b.Queue(updateSQL, next.ID, next.CreatedAt, next.Status, nullStr(next.ConnectionID), next.SMSCMsgIDs,
				next.ErrorCode, next.DLRStat, next.DLRErr, next.RouteCost, next.ClientCost, next.ResellerCost,
				next.Refunded, next.SubmittedAt, next.DLRReceivedAt)
			applied = append(applied, k)
		}
		if len(applied) > 0 {
			br := tx.SendBatch(ctx, b)
			for range applied {
				if _, err := br.Exec(); err != nil {
					br.Close()
					return nil, fmt.Errorf("cdr: update: %w", err)
				}
			}
			if err := br.Close(); err != nil {
				return nil, fmt.Errorf("cdr: update batch: %w", err)
			}
			nUpd = len(applied)
		}
	}

	if err := roll.write(ctx, tx); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("cdr: commit: %w", err)
	}
	if w.m != nil {
		w.m.CDRWritten.With("insert").Add(float64(nIns))
		w.m.CDRWritten.With("update").Add(float64(nUpd))
	}
	return unmatched, nil
}

const insertSQL = `
INSERT INTO message_logs (
  id, created_at, org_id, reseller_id, route_id, connection_id, template_id, campaign_id,
  channel, client_msg_ref, source_addr, source_ton, source_npi, destination_addr, dest_ton, dest_npi,
  country_iso, orig_text, sent_text, otp_extracted, encoding, parts, status, error_code,
  client_rate_micros, client_cost_micros, reseller_cost_micros, route_cost_micros, refunded, submitted_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::msg_channel, $10, $11, $12, $13, $14, $15, $16,
  $17, $18, $19, $20, $21::msg_encoding, $22, $23::msg_status, $24, $25, $26, $27, $28, $29, $30)
ON CONFLICT (id, created_at) DO NOTHING`

func nullStr(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func insertArgs(r *Record) []any {
	return []any{
		r.ID, r.CreatedAt, r.OrgID, nullStr(r.ResellerID), nullStr(r.RouteID), nullStr(r.ConnectionID),
		nullStr(r.TemplateID), nullStr(r.CampaignID), r.Channel, nullStr(r.ClientMsgRef),
		nullStr(truncate(r.SourceAddr, 21)), int16(r.SourceTON), int16(r.SourceNPI), truncate(r.DestinationAddr, 21),
		int16(r.DestTON), int16(r.DestNPI), nullStr(r.CountryISO), r.OrigText, nullStr(r.SentText), r.OTPExtracted,
		r.Encoding, int16(r.Parts), r.Status, nullStr(r.ErrorCode), r.ClientRateMicros, r.ClientCostMicros,
		r.ResellerCostMicros, r.RouteCostMicros, r.Refunded, r.SubmittedAt,
	}
}

func truncate(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}

// row is the part of message_logs the updater reads and writes.
type row struct {
	ID         string
	CreatedAt  time.Time
	OrgID      string
	ResellerID *string
	RouteID    *string
	CountryISO *string
	Parts      int

	Status        string
	ConnectionID  string
	SMSCMsgIDs    []string
	ErrorCode     *string
	DLRStat       *string
	DLRErr        *string
	RouteCost     *int64
	ClientCost    *int64
	ResellerCost  *int64
	Refunded      bool
	SubmittedAt   *time.Time
	DLRReceivedAt *time.Time
}

func lockRows(ctx context.Context, tx pgx.Tx, ids []string, ats []time.Time) (map[rowKey]*row, error) {
	rows, err := tx.Query(ctx, `
		SELECT m.id::text, m.created_at, m.org_id::text, m.reseller_id::text, m.route_id::text, m.country_iso::text,
		       m.parts, m.status::text, coalesce(m.connection_id::text, ''), m.smsc_msg_ids, m.error_code,
		       m.dlr_stat, m.dlr_err, m.route_cost_micros, m.client_cost_micros, m.reseller_cost_micros,
		       m.refunded, m.submitted_at, m.dlr_received_at
		  FROM message_logs m
		  JOIN unnest($1::uuid[], $2::timestamptz[]) AS k(id, created_at)
		    ON m.id = k.id AND m.created_at = k.created_at
		 ORDER BY m.id, m.created_at
		   FOR UPDATE OF m`, ids, ats)
	if err != nil {
		return nil, fmt.Errorf("cdr: lock rows: %w", err)
	}
	defer rows.Close()
	out := make(map[rowKey]*row, len(ids))
	for rows.Next() {
		r := &row{}
		if err := rows.Scan(&r.ID, &r.CreatedAt, &r.OrgID, &r.ResellerID, &r.RouteID, &r.CountryISO, &r.Parts,
			&r.Status, &r.ConnectionID, &r.SMSCMsgIDs, &r.ErrorCode, &r.DLRStat, &r.DLRErr, &r.RouteCost,
			&r.ClientCost, &r.ResellerCost, &r.Refunded, &r.SubmittedAt, &r.DLRReceivedAt); err != nil {
			return nil, fmt.Errorf("cdr: scan: %w", err)
		}
		out[keyOf(r.ID, r.CreatedAt)] = r
	}
	return out, rows.Err()
}

func apply(cur *row, u *Update) *row {
	n := *cur
	if u.Status != "" && Rank(u.Status) > Rank(cur.Status) {
		n.Status = u.Status
	}
	if u.ConnectionID != "" {
		n.ConnectionID = u.ConnectionID
	}
	if u.SMSCMsgIDs != nil {
		n.SMSCMsgIDs = u.SMSCMsgIDs
	}
	if u.ErrorCode != nil {
		n.ErrorCode = u.ErrorCode
	}
	if u.DLRStat != nil {
		v := truncate(*u.DLRStat, 7)
		n.DLRStat = &v
	}
	if u.DLRErr != nil {
		v := truncate(*u.DLRErr, 3)
		n.DLRErr = &v
	}
	if u.RouteCostMicros != nil {
		n.RouteCost = u.RouteCostMicros
	}
	if u.ClientCostMicros != nil {
		n.ClientCost = u.ClientCostMicros
	}
	if u.ResellerCostMicros != nil {
		n.ResellerCost = u.ResellerCostMicros
	}
	if u.Refunded != nil && *u.Refunded {
		n.Refunded = true
	}
	if u.SubmittedAt != nil && cur.SubmittedAt == nil {
		n.SubmittedAt = u.SubmittedAt
	}
	if u.DLRReceivedAt != nil {
		n.DLRReceivedAt = u.DLRReceivedAt
	}
	if n.SMSCMsgIDs == nil {
		n.SMSCMsgIDs = []string{}
	}
	return &n
}

const updateSQL = `
UPDATE message_logs SET
  status = $3::msg_status, connection_id = $4, smsc_msg_ids = $5, error_code = $6, dlr_stat = $7,
  dlr_err = $8, route_cost_micros = $9, client_cost_micros = $10, reseller_cost_micros = $11,
  refunded = $12, submitted_at = $13, dlr_received_at = $14
WHERE id = $1 AND created_at = $2`
