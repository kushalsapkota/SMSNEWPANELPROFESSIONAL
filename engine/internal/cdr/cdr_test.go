package cdr

import (
	"context"
	"errors"
	"fmt"
	"os"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Integration tests against Postgres sms_flow (db/reset-db.sh sms_flow) as
// the engine login. Every test uses fresh org/route ids.

func testPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		dsn = "postgres://sms_engine_login:sms_engine_dev@localhost:5432/sms_flow"
	}
	pool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Fatal(err)
	}
	if err := pool.Ping(context.Background()); err != nil {
		t.Fatalf("postgres (run db/reset-db.sh sms_flow): %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func i64(v int64) *int64          { return &v }
func str(v string) *string        { return &v }
func bptr(v bool) *bool           { return &v }
func tptr(v time.Time) *time.Time { return &v }

type stats struct {
	messages, parts, submitted, delivered, undelivered, failed, rejected, expired int64
	client, reseller, route                                                       int64
}

func readStats(t *testing.T, pool *pgxpool.Pool, org string) stats {
	t.Helper()
	var s stats
	err := pool.QueryRow(context.Background(), `
		SELECT coalesce(sum(messages),0), coalesce(sum(parts),0), coalesce(sum(submitted),0), coalesce(sum(delivered),0),
		       coalesce(sum(undelivered),0), coalesce(sum(failed),0), coalesce(sum(rejected),0), coalesce(sum(expired),0),
		       coalesce(sum(client_cost_micros),0), coalesce(sum(reseller_cost_micros),0), coalesce(sum(route_cost_micros),0)
		  FROM message_stats_hourly WHERE org_id = $1`, org).Scan(&s.messages, &s.parts, &s.submitted, &s.delivered,
		&s.undelivered, &s.failed, &s.rejected, &s.expired, &s.client, &s.reseller, &s.route)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func newWriter(t *testing.T, pool *pgxpool.Pool) (*Writer, context.Context) {
	w := New(pool, Options{FlushInterval: 20 * time.Millisecond, BatchSize: 50, UnmatchedRetry: 2 * time.Second})
	go w.Run(context.Background())
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	t.Cleanup(func() {
		cancel()
		_ = w.Close(context.Background())
	})
	return w, ctx
}

// cleanupOrg removes the rows a test wrote for org.
func cleanupOrg(t *testing.T, pool *pgxpool.Pool, org string) {
	t.Cleanup(func() {
		ctx := context.Background()
		pool.Exec(ctx, `DELETE FROM message_logs WHERE org_id = $1`, org)
		pool.Exec(ctx, `DELETE FROM message_stats_hourly WHERE org_id = $1`, org)
	})
}

func rec(org, reseller, route string, created time.Time) Record {
	return Record{
		ID: uuid.Must(uuid.NewV7()).String(), CreatedAt: created, OrgID: org, ResellerID: reseller, RouteID: route,
		Channel: "HTTP", SourceAddr: "MYBANK", SourceTON: 5, DestinationAddr: "919876543210", DestTON: 1, DestNPI: 1,
		OrigText: "code 1234", SentText: "Your code 1234", Encoding: "GSM7", Parts: 2,
		ClientRateMicros: i64(100), ClientCostMicros: i64(200), ResellerCostMicros: i64(80),
	}
}

func TestInsertUpdateRollups(t *testing.T) {
	pool := testPool(t)
	w, ctx := newWriter(t, pool)
	org, res, route := uuid.NewString(), uuid.NewString(), uuid.NewString()
	cleanupOrg(t, pool, org)
	created := time.Now().UTC().Truncate(time.Millisecond)

	a := rec(org, res, route, created)
	b := rec(org, res, route, created)
	for _, r := range []Record{a, b} {
		if err := w.Insert(ctx, r); err != nil {
			t.Fatal(err)
		}
	}
	// a: SUBMITTED then DELIVERED, in the same batch.
	sub := created.Add(time.Second)
	if err := w.Update(ctx, Update{ID: a.ID, CreatedAt: a.CreatedAt, Status: StatusSubmitted, ConnectionID: uuid.NewString(),
		SMSCMsgIDs: []string{"abc", "abd"}, RouteCostMicros: i64(30), SubmittedAt: &sub}); err != nil {
		t.Fatal(err)
	}
	if err := w.Update(ctx, Update{ID: a.ID, CreatedAt: a.CreatedAt, Status: StatusDelivered, DLRStat: str("DELIVRD"),
		DLRErr: str("000"), DLRReceivedAt: tptr(time.Now())}); err != nil {
		t.Fatal(err)
	}
	// b: FAILED + refunded.
	if err := w.Update(ctx, Update{ID: b.ID, CreatedAt: b.CreatedAt, Status: StatusFailed, ErrorCode: str("ESME_RSUBMITFAIL"),
		Refunded: bptr(true)}); err != nil {
		t.Fatal(err)
	}
	if err := w.Flush(ctx); err != nil {
		t.Fatal(err)
	}
	got := readStats(t, pool, org)
	want := stats{messages: 2, parts: 4, submitted: 1, delivered: 1, failed: 1, client: 200, reseller: 80, route: 30}
	if got != want {
		t.Fatalf("stats\n got %+v\nwant %+v", got, want)
	}

	// Late SUBMITTED for a must not regress the status nor double count.
	if err := w.Update(ctx, Update{ID: a.ID, CreatedAt: a.CreatedAt, Status: StatusSubmitted, SubmittedAt: &sub}); err != nil {
		t.Fatal(err)
	}
	// A duplicate final for b changes nothing.
	if err := w.Update(ctx, Update{ID: b.ID, CreatedAt: b.CreatedAt, Status: StatusFailed, Refunded: bptr(true)}); err != nil {
		t.Fatal(err)
	}
	if err := w.Flush(ctx); err != nil {
		t.Fatal(err)
	}
	if got := readStats(t, pool, org); got != want {
		t.Fatalf("after replay\n got %+v\nwant %+v", got, want)
	}

	var status, dlr string
	var ids []string
	var refunded bool
	if err := pool.QueryRow(ctx, `SELECT status::text, coalesce(dlr_stat,''), smsc_msg_ids, refunded FROM message_logs WHERE id=$1 AND created_at=$2`,
		a.ID, a.CreatedAt).Scan(&status, &dlr, &ids, &refunded); err != nil {
		t.Fatal(err)
	}
	if status != StatusDelivered || dlr != "DELIVRD" || len(ids) != 2 || refunded {
		t.Fatalf("row a: %s %s %v %v", status, dlr, ids, refunded)
	}
	if err := pool.QueryRow(ctx, `SELECT status::text, refunded FROM message_logs WHERE id=$1 AND created_at=$2`,
		b.ID, b.CreatedAt).Scan(&status, &refunded); err != nil {
		t.Fatal(err)
	}
	if status != StatusFailed || !refunded {
		t.Fatalf("row b: %s %v", status, refunded)
	}
}

func TestFinalStatusMovesBetweenCounters(t *testing.T) {
	pool := testPool(t)
	w, ctx := newWriter(t, pool)
	org, route := uuid.NewString(), uuid.NewString()
	cleanupOrg(t, pool, org)
	r := rec(org, "", route, time.Now().UTC().Truncate(time.Millisecond))
	r.Status = StatusSubmitted
	r.SubmittedAt = tptr(r.CreatedAt)
	if err := w.Insert(ctx, r); err != nil {
		t.Fatal(err)
	}
	if err := w.Flush(ctx); err != nil {
		t.Fatal(err)
	}
	// Partial refund: client pays one part less.
	if err := w.Update(ctx, Update{ID: r.ID, CreatedAt: r.CreatedAt, ClientCostMicros: i64(100), ResellerCostMicros: i64(40)}); err != nil {
		t.Fatal(err)
	}
	if err := w.Update(ctx, Update{ID: r.ID, CreatedAt: r.CreatedAt, Status: StatusUndelivered}); err != nil {
		t.Fatal(err)
	}
	if err := w.Flush(ctx); err != nil {
		t.Fatal(err)
	}
	got := readStats(t, pool, org)
	want := stats{messages: 1, parts: 2, submitted: 1, undelivered: 1, client: 100, reseller: 40}
	if got != want {
		t.Fatalf("got %+v want %+v", got, want)
	}
}

func TestUnmatchedUpdateIsRetried(t *testing.T) {
	pool := testPool(t)
	w, ctx := newWriter(t, pool)
	org, route := uuid.NewString(), uuid.NewString()
	cleanupOrg(t, pool, org)
	r := rec(org, "", route, time.Now().UTC().Truncate(time.Millisecond))
	// The update arrives first (as when another instance has not committed the insert yet).
	if err := w.Update(ctx, Update{ID: r.ID, CreatedAt: r.CreatedAt, Status: StatusSubmitted, SubmittedAt: tptr(time.Now())}); err != nil {
		t.Fatal(err)
	}
	if err := w.Flush(ctx); err != nil {
		t.Fatal(err)
	}
	// Insert directly (as the other instance would).
	other := New(pool, Options{})
	go other.Run(context.Background())
	if err := other.Insert(ctx, r); err != nil {
		t.Fatal(err)
	}
	if err := other.Close(ctx); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		var status string
		if err := pool.QueryRow(ctx, `SELECT status::text FROM message_logs WHERE id=$1 AND created_at=$2`, r.ID, r.CreatedAt).Scan(&status); err != nil {
			t.Fatal(err)
		}
		if status == StatusSubmitted {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("retried update never applied (status %s)", status)
		}
		time.Sleep(20 * time.Millisecond)
	}
	if got := readStats(t, pool, org); got.submitted != 1 || got.messages != 1 {
		t.Fatalf("stats %+v", got)
	}
}

func TestCloseDrains(t *testing.T) {
	pool := testPool(t)
	w := New(pool, Options{FlushInterval: time.Hour, BatchSize: 1000})
	go w.Run(context.Background())
	ctx := context.Background()
	org, route := uuid.NewString(), uuid.NewString()
	cleanupOrg(t, pool, org)
	for i := 0; i < 25; i++ {
		if err := w.Insert(ctx, rec(org, "", route, time.Now().UTC().Truncate(time.Millisecond))); err != nil {
			t.Fatal(err)
		}
	}
	if err := w.Close(ctx); err != nil {
		t.Fatal(err)
	}
	if err := w.Insert(ctx, rec(org, "", route, time.Now())); err != ErrClosed {
		t.Fatalf("insert after close: %v", err)
	}
	var n int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM message_logs WHERE org_id=$1`, org).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 25 {
		t.Fatalf("rows %d", n)
	}
	if got := readStats(t, pool, org); got.messages != 25 || got.parts != 50 {
		t.Fatalf("stats %+v", got)
	}
}

func TestValidation(t *testing.T) {
	w := New(nil, Options{})
	ctx := context.Background()
	if err := w.Insert(ctx, Record{}); err == nil {
		t.Fatal("expected error")
	}
	if err := w.Update(ctx, Update{ID: "x", CreatedAt: time.Now(), Status: "BOGUS"}); err == nil {
		t.Fatal("expected error")
	}
	if Rank(StatusDelivered) <= Rank(StatusSubmitted) || !IsFinal(StatusExpired) || IsFinal(StatusQueued) {
		t.Fatal("rank")
	}
}

// flakyDB fails BeginTx (like a lost connection) while down is set.
type flakyDB struct {
	pool *pgxpool.Pool
	down atomic.Bool
	hits atomic.Int32
}

func (f *flakyDB) BeginTx(ctx context.Context, opts pgx.TxOptions) (pgx.Tx, error) {
	if f.down.Load() {
		f.hits.Add(1)
		return nil, errors.New("dial tcp: connection refused")
	}
	return f.pool.BeginTx(ctx, opts)
}

func TestOutageKeepsOperationsQueued(t *testing.T) {
	pool := testPool(t)
	db := &flakyDB{pool: pool}
	db.down.Store(true)
	w := New(db, Options{FlushInterval: 10 * time.Millisecond, BatchSize: 10})
	go w.Run(context.Background())
	ctx := context.Background()
	org, route := uuid.NewString(), uuid.NewString()
	cleanupOrg(t, pool, org)
	r := rec(org, "", route, time.Now().UTC().Truncate(time.Millisecond))
	if err := w.Insert(ctx, r); err != nil {
		t.Fatal(err)
	}
	if err := w.Update(ctx, Update{ID: r.ID, CreatedAt: r.CreatedAt, Status: StatusSubmitted, SubmittedAt: tptr(time.Now())}); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for db.hits.Load() < 3 {
		if time.Now().After(deadline) {
			t.Fatal("writer did not retry")
		}
		time.Sleep(10 * time.Millisecond)
	}
	db.down.Store(false)
	if err := w.Close(ctx); err != nil {
		t.Fatal(err)
	}
	var status string
	if err := pool.QueryRow(ctx, `SELECT status::text FROM message_logs WHERE id=$1 AND created_at=$2`, r.ID, r.CreatedAt).Scan(&status); err != nil {
		t.Fatalf("row lost during outage: %v", err)
	}
	if status != StatusSubmitted {
		t.Fatalf("status %s", status)
	}
	if got := readStats(t, pool, org); got.messages != 1 || got.submitted != 1 {
		t.Fatalf("stats %+v", got)
	}
}

func TestIsDataError(t *testing.T) {
	if isDataError(errors.New("x")) || isDataError(&pgconn.PgError{Code: "08006"}) || isDataError(&pgconn.PgError{Code: "40P01"}) ||
		!isDataError(&pgconn.PgError{Code: "23505"}) || !isDataError(fmt.Errorf("wrapped: %w", &pgconn.PgError{Code: "22P02"})) {
		t.Fatal("classification")
	}
}
