package webhook

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"

	"smsgw/engine/internal/store"
)

// Integration tests: Postgres sms_flow, Redis db 2 (unique key prefix per test).

func env(t *testing.T) (*pgxpool.Pool, *redis.Client) {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		dsn = "postgres://sms_engine_login:sms_engine_dev@localhost:5432/sms_flow"
	}
	ru := os.Getenv("TEST_REDIS_URL")
	if ru == "" {
		ru = "redis://localhost:6399/2"
	}
	pool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Fatal(err)
	}
	if err := pool.Ping(context.Background()); err != nil {
		t.Fatalf("postgres (run db/reset-db.sh sms_flow): %v", err)
	}
	opt, err := redis.ParseURL(ru)
	if err != nil {
		t.Fatal(err)
	}
	rdb := redis.NewClient(opt)
	if err := rdb.Ping(context.Background()).Err(); err != nil {
		t.Fatalf("redis: %v", err)
	}
	t.Cleanup(func() { pool.Close(); rdb.Close() })
	return pool, rdb
}

type staticSnap struct{ s *store.Snapshot }

func (s staticSnap) Current() *store.Snapshot { return s.s }

func prefix() string {
	b := make([]byte, 6)
	_, _ = rand.Read(b)
	return "test:wh:" + hex.EncodeToString(b) + ":"
}

func cleanup(t *testing.T, rdb *redis.Client, p string) {
	t.Cleanup(func() {
		ctx := context.Background()
		keys, _ := rdb.Keys(ctx, p+"*").Result()
		if len(keys) > 0 {
			rdb.Del(ctx, keys...)
		}
	})
}

func seedWebhook(t *testing.T, pool *pgxpool.Pool, url string, maxRetries int) (org, wh string) {
	t.Helper()
	org, wh = uuid.NewString(), uuid.NewString()
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `INSERT INTO organizations (id, role, name) VALUES ($1, 'SUPER_ADMIN', $2)`, org, "wh-"+org); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO webhooks (id, org_id, url, secret_enc, max_retries) VALUES ($1, $2, $3, 'v1:x', $4)`, wh, org, url, maxRetries); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { pool.Exec(context.Background(), `DELETE FROM organizations WHERE id = $1`, org) })
	return org, wh
}

func snapWith(org, wh, url, secret string, maxRetries int, enabled bool) staticSnap {
	return staticSnap{store.NewSnapshot(store.Data{Webhooks: []*store.Webhook{{
		ID: wh, OrgID: org, URL: url, Secret: secret, Events: []string{"dlr"}, MaxRetries: maxRetries, Enabled: enabled,
	}}})}
}

func TestRetriesSignatureAndLogging(t *testing.T) {
	pool, rdb := env(t)
	var calls atomic.Int32
	var mu sync.Mutex
	var bodies []string
	sigOK := true
	const secret = "whsec_test"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		mu.Lock()
		bodies = append(bodies, string(b))
		if !Verify(secret, r.Header.Get("X-Webhook-Timestamp"), r.Header.Get("X-Webhook-Signature"), b) ||
			r.Header.Get("X-Webhook-Event") != "dlr" || r.Header.Get("Content-Type") != "application/json" {
			sigOK = false
		}
		mu.Unlock()
		if calls.Add(1) <= 2 {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()
	org, wh := seedWebhook(t, pool, srv.URL, 5)
	p := prefix()
	cleanup(t, rdb, p)
	q := New(rdb, pool, snapWith(org, wh, srv.URL, secret, 5, true), Options{KeyPrefix: p, BaseBackoff: 50 * time.Millisecond, PollInterval: 10 * time.Millisecond})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	go func() { q.Run(ctx); close(done) }()

	msg := uuid.NewString()
	d := Delivery{WebhookID: wh, OrgID: org, MessageID: msg, Event: "dlr", Body: []byte(`{"event":"dlr","message_id":"` + msg + `"}`)}
	if err := q.Enqueue(ctx, d); err != nil {
		t.Fatal(err)
	}
	if err := q.Enqueue(ctx, d); err != nil { // duplicate: ignored
		t.Fatal(err)
	}
	deadline := time.Now().Add(10 * time.Second)
	for calls.Load() < 3 {
		if time.Now().After(deadline) {
			t.Fatalf("only %d calls", calls.Load())
		}
		time.Sleep(10 * time.Millisecond)
	}
	// Wait for the job to be finished and the rows to be written.
	for {
		n, _ := q.Pending(ctx)
		var rows int
		_ = pool.QueryRow(ctx, `SELECT count(*) FROM webhook_deliveries WHERE webhook_id=$1`, wh).Scan(&rows)
		if n == 0 && rows == 3 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("pending %d rows %d", n, rows)
		}
		time.Sleep(10 * time.Millisecond)
	}
	time.Sleep(100 * time.Millisecond)
	if c := calls.Load(); c != 3 {
		t.Fatalf("calls %d (duplicate enqueue or extra retry)", c)
	}
	mu.Lock()
	if !sigOK || bodies[0] != string(d.Body) {
		t.Fatalf("bad signature/body: %v %q", sigOK, bodies)
	}
	mu.Unlock()
	rows, err := pool.Query(ctx, `SELECT attempt, coalesce(status_code, 0), coalesce(error, ''), message_id::text FROM webhook_deliveries WHERE webhook_id=$1 ORDER BY id`, wh)
	if err != nil {
		t.Fatal(err)
	}
	var got []int
	for rows.Next() {
		var a, sc int
		var e, mid string
		if err := rows.Scan(&a, &sc, &e, &mid); err != nil {
			t.Fatal(err)
		}
		if mid != msg {
			t.Fatalf("message id %s", mid)
		}
		got = append(got, a*1000+sc)
	}
	rows.Close()
	if len(got) != 3 || got[0] != 1503 || got[1] != 2503 || got[2] != 3204 {
		t.Fatalf("attempts %v", got)
	}
	var fc int
	var lastFail *time.Time
	if err := pool.QueryRow(ctx, `SELECT failure_count, last_failure_at FROM webhooks WHERE id=$1`, wh).Scan(&fc, &lastFail); err != nil {
		t.Fatal(err)
	}
	if fc != 0 || lastFail == nil {
		t.Fatalf("failure_count %d last_failure_at %v", fc, lastFail)
	}
	// Completed jobs are not re-enqueued.
	if err := q.Enqueue(ctx, d); err != nil {
		t.Fatal(err)
	}
	if n, _ := q.Pending(ctx); n != 0 {
		t.Fatalf("re-enqueued completed job")
	}
	cancel()
	<-done
}

func TestGivesUpAfterMaxRetriesAndSurvivesRestart(t *testing.T) {
	pool, rdb := env(t)
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()
	org, wh := seedWebhook(t, pool, srv.URL, 2)
	p := prefix()
	cleanup(t, rdb, p)
	snap := snapWith(org, wh, srv.URL, "s", 2, true)
	opts := Options{KeyPrefix: p, BaseBackoff: 300 * time.Millisecond, PollInterval: 10 * time.Millisecond}

	// First "process": one attempt, then shut down before the retry is due.
	q1 := New(rdb, pool, snap, opts)
	ctx1, cancel1 := context.WithCancel(context.Background())
	done1 := make(chan struct{})
	go func() { q1.Run(ctx1); close(done1) }()
	if err := q1.Enqueue(ctx1, Delivery{WebhookID: wh, OrgID: org, MessageID: uuid.NewString(), Event: "dlr", Body: []byte(`{}`)}); err != nil {
		t.Fatal(err)
	}
	for calls.Load() < 1 {
		time.Sleep(5 * time.Millisecond)
	}
	cancel1()
	<-done1
	if n, _ := q1.Pending(context.Background()); n != 1 {
		t.Fatalf("job lost on shutdown: pending %d", n)
	}

	// Second "process" picks the job up from Redis and exhausts retries (1 + 2).
	q2 := New(rdb, pool, snap, opts)
	ctx2, cancel2 := context.WithCancel(context.Background())
	defer cancel2()
	go q2.Run(ctx2)
	deadline := time.Now().Add(10 * time.Second)
	for {
		n, _ := q2.Pending(ctx2)
		if n == 0 && calls.Load() == 3 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("calls %d pending %d", calls.Load(), n)
		}
		time.Sleep(10 * time.Millisecond)
	}
	time.Sleep(700 * time.Millisecond)
	if c := calls.Load(); c != 3 {
		t.Fatalf("calls %d after giving up", c)
	}
	var fc int
	if err := pool.QueryRow(ctx2, `SELECT failure_count FROM webhooks WHERE id=$1`, wh).Scan(&fc); err != nil {
		t.Fatal(err)
	}
	if fc != 3 {
		t.Fatalf("failure_count %d", fc)
	}
}

func TestDisabledWebhookDropped(t *testing.T) {
	_, rdb := env(t)
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1) }))
	defer srv.Close()
	org, wh := uuid.NewString(), uuid.NewString()
	p := prefix()
	cleanup(t, rdb, p)
	q := New(rdb, nil, snapWith(org, wh, srv.URL, "s", 3, false), Options{KeyPrefix: p, PollInterval: 10 * time.Millisecond})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go q.Run(ctx)
	if err := q.Enqueue(ctx, Delivery{WebhookID: wh, OrgID: org, MessageID: "m", Event: "dlr", Body: []byte(`{}`)}); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		if n, _ := q.Pending(ctx); n == 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("job not dropped")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if calls.Load() != 0 {
		t.Fatal("disabled webhook was called")
	}
}

func TestBackoffAndSign(t *testing.T) {
	q := New(nil, nil, nil, Options{})
	if q.Backoff(1) != 10*time.Second || q.Backoff(2) != 20*time.Second || q.Backoff(4) != 80*time.Second || q.Backoff(30) != 6*time.Hour {
		t.Fatalf("backoff %v %v %v %v", q.Backoff(1), q.Backoff(2), q.Backoff(4), q.Backoff(30))
	}
	// Known vector: HMAC-SHA256("secret", "1700000000.{}")
	sig := Sign("secret", 1700000000, []byte("{}"))
	if !Verify("secret", "1700000000", sig, []byte("{}")) || Verify("other", "1700000000", sig, []byte("{}")) {
		t.Fatal("verify")
	}
	if len(sig) != len("sha256=")+64 {
		t.Fatal(sig)
	}
}
