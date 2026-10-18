package billing

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"

	"smsgw/engine/internal/policy"
)

// Integration tests use the engine-core test resources (CONTRACTS §1):
// Postgres db sms_core (db/reset-db.sh sms_core) and Redis db 1 on :6399.
// Override with TEST_DATABASE_URL / TEST_REDIS_URL. Every test uses fresh
// UUIDs and its own dirty-set key, so nothing is flushed.

func testEnv(t *testing.T) (*pgxpool.Pool, *redis.Client) {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		dsn = "postgres://sms_engine_login:sms_engine_dev@localhost:5432/sms_core"
	}
	rurl := os.Getenv("TEST_REDIS_URL")
	if rurl == "" {
		rurl = "redis://localhost:6399/1"
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatalf("postgres: %v", err)
	}
	if err := pool.Ping(ctx); err != nil {
		t.Fatalf("postgres ping (run db/reset-db.sh sms_core): %v", err)
	}
	opt, err := redis.ParseURL(rurl)
	if err != nil {
		t.Fatal(err)
	}
	opt.PoolSize = 64
	rdb := redis.NewClient(opt)
	if err := rdb.Ping(ctx).Err(); err != nil {
		t.Fatalf("redis: %v", err)
	}
	t.Cleanup(func() { pool.Close(); _ = rdb.Close() })
	return pool, rdb
}

type tree struct {
	admin, reseller string
	clients         []string
}

// newTree inserts SUPER_ADMIN -> RESELLER -> n CLIENTs with balances.
func newTree(t *testing.T, pool *pgxpool.Pool, resellerBal int64, clientBals ...int64) tree {
	t.Helper()
	ctx := context.Background()
	tr := tree{admin: uuid.NewString(), reseller: uuid.NewString()}
	exec := func(sql string, args ...any) {
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatalf("%s: %v", sql, err)
		}
	}
	exec(`INSERT INTO organizations (id, role, name) VALUES ($1, 'SUPER_ADMIN', $2)`, tr.admin, "admin-"+tr.admin[:8])
	exec(`INSERT INTO organizations (id, role, parent_id, name) VALUES ($1, 'RESELLER', $2, $3)`, tr.reseller, tr.admin, "res-"+tr.reseller[:8])
	exec(`INSERT INTO accounts_balance (org_id, balance_micros) VALUES ($1, $2)`, tr.reseller, resellerBal)
	for _, b := range clientBals {
		id := uuid.NewString()
		exec(`INSERT INTO organizations (id, role, parent_id, name) VALUES ($1, 'CLIENT', $2, $3)`, id, tr.reseller, "cli-"+id[:8])
		exec(`INSERT INTO accounts_balance (org_id, balance_micros) VALUES ($1, $2)`, id, b)
		tr.clients = append(tr.clients, id)
	}
	return tr
}

func newBiller(t *testing.T, pool *pgxpool.Pool, rdb *redis.Client) *Biller {
	dirty := "test:bal:dirty:" + uuid.NewString()
	t.Cleanup(func() { rdb.Del(context.Background(), dirty) })
	return New(rdb, pool, Options{TxnTTL: time.Hour, CreditIdemTTL: time.Hour, DirtyKey: dirty})
}

func cleanupKeys(t *testing.T, rdb *redis.Client, tr tree) {
	t.Cleanup(func() {
		ctx := context.Background()
		keys := []string{BalanceKey(tr.reseller, tr.reseller)}
		for _, c := range tr.clients {
			keys = append(keys, BalanceKey(tr.reseller, c))
		}
		rdb.Del(ctx, keys...)
		iter := rdb.Scan(ctx, 0, "{t:"+tr.reseller+"}:*", 1000).Iterator()
		for iter.Next(ctx) {
			rdb.Del(ctx, iter.Val())
		}
	})
}

func pgBalance(t *testing.T, pool *pgxpool.Pool, org string) (int64, *time.Time) {
	t.Helper()
	var bal int64
	var at *time.Time
	if err := pool.QueryRow(context.Background(),
		`SELECT balance_micros, synced_at FROM accounts_balance WHERE org_id = $1`, org).Scan(&bal, &at); err != nil {
		t.Fatal(err)
	}
	return bal, at
}

func TestEmbeddedScriptsMatchCanonical(t *testing.T) {
	embedded := map[string]string{"debit.lua": debitSrc, "refund.lua": refundSrc, "credit.lua": creditSrc, "load.lua": loadSrc}
	for name, src := range embedded {
		canon, err := os.ReadFile(filepath.Join("..", "..", "..", "redis", "lua", name))
		if err != nil {
			t.Fatalf("read canonical %s: %v", name, err)
		}
		if !bytes.Equal(canon, []byte(src)) {
			t.Errorf("%s: embedded copy differs from redis/lua/%s — re-copy it", name, name)
		}
	}
	entries, _ := os.ReadDir(filepath.Join("..", "..", "..", "redis", "lua"))
	for _, e := range entries {
		if _, ok := embedded[e.Name()]; !ok && filepath.Ext(e.Name()) == ".lua" {
			t.Errorf("canonical script %s is not embedded", e.Name())
		}
	}
}

func TestKeys(t *testing.T) {
	if got := BalanceKey("r1", "c1"); got != "{t:r1}:bal:c1" {
		t.Error(got)
	}
	if got := TxnKey("r1", "m1"); got != "{t:r1}:txn:m1" {
		t.Error(got)
	}
	if got := CreditKey("r1", "k"); got != "{t:r1}:credit:k" {
		t.Error(got)
	}
	if TagFor(RoleClient, "c", "r") != "r" || TagFor(RoleReseller, "r", "a") != "r" || TagFor(RoleSuperAdmin, "a", "") != "" {
		t.Error("TagFor")
	}
	if tag, org, ok := parseDirtyMember(dirtyMember("r", "c")); !ok || tag != "r" || org != "c" {
		t.Error("dirty member")
	}
}

func TestDebitHydratesRefundsAndSyncs(t *testing.T) {
	pool, rdb := testEnv(t)
	tr := newTree(t, pool, 10_000, 5_000)
	cleanupKeys(t, rdb, tr)
	b := newBiller(t, pool, rdb)
	ctx := context.Background()
	c, r := tr.clients[0], tr.reseller
	legs := []Leg{{OrgID: c, Tag: r, Amount: 300}, {OrgID: r, Tag: r, Amount: 100}}

	// Neither balance is loaded: NOT_LOADED -> hydrate -> retry.
	res, err := b.Debit(ctx, "m1", legs)
	if err != nil || res.Status != StatusOK || res.Balances[0] != 4_700 || res.Balances[1] != 9_900 {
		t.Fatalf("debit: %+v %v", res, err)
	}
	res, err = b.Debit(ctx, "m1", legs)
	if err != nil || res.Status != StatusDuplicate || res.Balances[0] != 4_700 {
		t.Fatalf("duplicate: %+v %v", res, err)
	}
	rr, err := b.Refund(ctx, "m1", legs, []int64{100, 0})
	if err != nil || rr.Status != StatusOK || rr.Refunded[0] != 100 || rr.Refunded[1] != 0 {
		t.Fatalf("partial refund: %+v %v", rr, err)
	}
	rr, err = b.Refund(ctx, "m1", legs, nil)
	if err != nil || rr.Status != StatusOK || rr.Refunded[0] != 200 || rr.Refunded[1] != 100 {
		t.Fatalf("full refund: %+v %v", rr, err)
	}
	if rr, _ = b.Refund(ctx, "m1", legs, nil); rr.Status != StatusNothingToRefund {
		t.Fatalf("double refund: %+v", rr)
	}
	if rr, _ = b.Refund(ctx, "nope", legs, nil); rr.Status != StatusNoTxn {
		t.Fatalf("unknown txn: %+v", rr)
	}
	if _, err := b.Refund(ctx, "m1", []Leg{legs[1], legs[0]}, nil); err == nil {
		t.Fatal("key mismatch not reported")
	}

	res, _ = b.Debit(ctx, "m2", legs)
	if res.Balances[0] != 4_700 {
		t.Fatalf("after refund+debit: %+v", res)
	}
	n, err := NewSyncer(b, SyncerOptions{FullEvery: -1}).SyncOnce(ctx)
	if err != nil || n != 2 {
		t.Fatalf("sync: %d %v", n, err)
	}
	if bal, at := pgBalance(t, pool, c); bal != 4_700 || at == nil {
		t.Fatalf("pg client %d %v", bal, at)
	}
	if bal, _ := pgBalance(t, pool, r); bal != 9_900 {
		t.Fatalf("pg reseller %d", bal)
	}
	info, err := b.Balance(ctx, r, c)
	if err != nil || !info.Loaded || info.Balance != 4_700 {
		t.Fatalf("balance %+v %v", info, err)
	}

	// Evict -> refund hydrates from the synced Postgres value and applies.
	if err := b.Evict(ctx, r, c); err != nil {
		t.Fatal(err)
	}
	rr, err = b.Refund(ctx, "m2", legs, nil)
	if err != nil || rr.Status != StatusOK {
		t.Fatalf("refund after evict: %+v %v", rr, err)
	}
	if info, _ := b.Peek(ctx, r, c); info.Balance != 5_000 {
		t.Fatalf("after evicted refund %+v", info)
	}
}

func TestInsufficientFundsAndPostpaid(t *testing.T) {
	pool, rdb := testEnv(t)
	tr := newTree(t, pool, 1_000, 100, 0)
	cleanupKeys(t, rdb, tr)
	b := newBiller(t, pool, rdb)
	ctx := context.Background()
	c, r := tr.clients[0], tr.reseller

	_, err := b.Debit(ctx, "x1", []Leg{{c, r, 200}, {r, r, 10}})
	if policy.CodeOf(err) != policy.CodeInsufficientFunds {
		t.Fatalf("expected INSUFFICIENT_FUNDS, got %v", err)
	}
	var ife *InsufficientFundsError
	if !errors.As(err, &ife) || ife.Leg != 0 || ife.OrgID != c {
		t.Fatalf("leg info: %+v", ife)
	}
	_, err = b.Debit(ctx, "x2", []Leg{{c, r, 50}, {r, r, 5_000}})
	if !errors.As(err, &ife) || ife.Leg != 1 {
		t.Fatalf("reseller short: %v", err)
	}
	if info, _ := b.Peek(ctx, r, c); info.Balance != 100 {
		t.Fatalf("client charged on failed debit: %+v", info)
	}

	// Postpaid client: may go to -limit.
	pc := tr.clients[1]
	if _, err := pool.Exec(ctx, `UPDATE accounts_balance SET billing_mode='POSTPAID', credit_limit_micros=500 WHERE org_id=$1`, pc); err != nil {
		t.Fatal(err)
	}
	if res, err := b.Debit(ctx, "p1", []Leg{{pc, r, 500}}); err != nil || res.Balances[0] != -500 {
		t.Fatalf("postpaid to -limit: %+v %v", res, err)
	}
	if _, err := b.Debit(ctx, "p2", []Leg{{pc, r, 1}}); policy.CodeOf(err) != policy.CodeInsufficientFunds {
		t.Fatalf("past limit: %v", err)
	}
	if ok, err := b.SetLimit(ctx, r, pc, 600); !ok || err != nil {
		t.Fatalf("set limit: %v %v", ok, err)
	}
	if _, err := b.Debit(ctx, "p3", []Leg{{pc, r, 100}}); err != nil {
		t.Fatalf("after raising limit: %v", err)
	}
	if ok, _ := b.SetLimit(ctx, r, uuid.NewString(), 1); ok {
		t.Fatal("set limit on unloaded key reported loaded")
	}
}

func TestValidationAndHydrationErrors(t *testing.T) {
	pool, rdb := testEnv(t)
	tr := newTree(t, pool, 1_000, 100)
	cleanupKeys(t, rdb, tr)
	b := newBiller(t, pool, rdb)
	ctx := context.Background()
	c, r := tr.clients[0], tr.reseller

	bad := [][]Leg{
		nil,
		{{c, r, -1}},
		{{c, r, 1}, {r, "other", 1}},
		{{c, r, 1}, {c, r, 1}},
		{{"", r, 1}},
	}
	for i, legs := range bad {
		if _, err := b.Debit(ctx, "v", legs); err == nil {
			t.Errorf("case %d accepted", i)
		}
	}
	// Wrong tag: refuses to create a key in the wrong slot.
	if _, err := b.Load(ctx, c, c); !errors.Is(err, ErrTagMismatch) {
		t.Fatalf("tag mismatch: %v", err)
	}
	if _, err := b.Load(ctx, tr.admin, tr.admin); !errors.Is(err, ErrNoAccount) {
		t.Fatalf("admin has no account row: %v", err)
	}
	ghost := uuid.NewString()
	if _, err := b.Debit(ctx, "g", []Leg{{ghost, r, 1}}); policy.CodeOf(err) != policy.CodeInsufficientFunds || !errors.Is(err, ErrNoAccount) {
		t.Fatalf("no account debit: %v", err)
	}
	if _, err := b.Balance(ctx, r, ghost); !errors.Is(err, ErrNoAccount) {
		t.Fatalf("no account balance: %v", err)
	}
}

func TestCredit(t *testing.T) {
	pool, rdb := testEnv(t)
	tr := newTree(t, pool, 1_000, 100)
	cleanupKeys(t, rdb, tr)
	b := newBiller(t, pool, rdb)
	ctx := context.Background()
	c, r := tr.clients[0], tr.reseller

	cr, err := b.Credit(ctx, r, c, 5_000, "topup-1")
	if err != nil || cr.Status != StatusNotLoaded || cr.Balance != nil {
		t.Fatalf("not loaded: %+v %v", cr, err)
	}
	if lr, err := b.Load(ctx, r, c); err != nil || lr.Status != StatusOK || lr.Balance != 100 {
		t.Fatalf("load: %+v %v", lr, err)
	}
	if lr, _ := b.Load(ctx, r, c); lr.Status != StatusAlreadyLoaded {
		t.Fatalf("reload: %+v", lr)
	}
	cr, err = b.Credit(ctx, r, c, 5_000, "topup-2")
	if err != nil || cr.Status != StatusOK || *cr.Balance != 5_100 {
		t.Fatalf("credit: %+v %v", cr, err)
	}
	cr, _ = b.Credit(ctx, r, c, 5_000, "topup-2")
	if cr.Status != StatusDuplicate || *cr.Balance != 5_100 {
		t.Fatalf("dup: %+v", cr)
	}
	cr, _ = b.Credit(ctx, r, c, -100, "adj-1")
	if cr.Status != StatusOK || *cr.Balance != 5_000 {
		t.Fatalf("negative adj: %+v", cr)
	}
	if n, err := NewSyncer(b, SyncerOptions{FullEvery: -1}).SyncOnce(ctx); err != nil || n != 1 {
		t.Fatalf("sync %d %v", n, err)
	}
	if bal, _ := pgBalance(t, pool, c); bal != 5_000 {
		t.Fatalf("pg %d", bal)
	}
}

// Hundreds of goroutines debit, duplicate-retry and refund concurrently while
// two syncers (two "engine instances") write back. Invariants: no balance
// ever below zero (prepaid), exactly floor(balance/amount) debits succeed,
// duplicates never charge, and Postgres ends equal to Redis.
func TestConcurrentDebitsWithSyncers(t *testing.T) {
	pool, rdb := testEnv(t)
	const (
		clientBal   = 10_000
		resellerBal = 1_000_000
		clientAmt   = 100
		resellerAmt = 50
		workers     = 400
	)
	tr := newTree(t, pool, resellerBal, clientBal, clientBal)
	cleanupKeys(t, rdb, tr)
	b := newBiller(t, pool, rdb)
	ctx, cancel := context.WithCancel(context.Background())
	r := tr.reseller

	var syncWG sync.WaitGroup
	for i := 0; i < 2; i++ {
		s := NewSyncer(b, SyncerOptions{Interval: 3 * time.Millisecond, FullEvery: 20 * time.Millisecond, Batch: 1})
		syncWG.Add(1)
		go func() { defer syncWG.Done(); s.Run(ctx) }()
	}

	var ok, insufficient, refunded [2]atomic.Int64
	var negative atomic.Bool
	var wg sync.WaitGroup
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			ci := w % 2
			legs := []Leg{{tr.clients[ci], r, clientAmt}, {r, r, resellerAmt}}
			txn := fmt.Sprintf("conc-%d", w)
			res, err := b.Debit(context.Background(), txn, legs)
			switch {
			case err == nil:
				ok[ci].Add(1)
				for _, v := range res.Balances {
					if v < 0 {
						negative.Store(true)
					}
				}
				// Retried submit must not double-charge.
				dup, err := b.Debit(context.Background(), txn, legs)
				if err != nil || dup.Status != StatusDuplicate {
					t.Errorf("dup: %+v %v", dup, err)
				}
				// Every 4th successful message fails upstream and is refunded.
				if w%4 == 0 {
					rr, err := b.Refund(context.Background(), txn, legs, nil)
					if err != nil || rr.Status != StatusOK {
						t.Errorf("refund: %+v %v", rr, err)
					}
					refunded[ci].Add(1)
				}
			case policy.CodeOf(err) == policy.CodeInsufficientFunds:
				insufficient[ci].Add(1)
			default:
				t.Errorf("debit: %v", err)
			}
		}(w)
	}
	wg.Wait()
	cancel()
	syncWG.Wait()
	if negative.Load() {
		t.Fatal("a balance went negative")
	}

	// Final flush (the Run final flush may race the last mutations of others).
	s := NewSyncer(b, SyncerOptions{FullEvery: -1})
	if err := s.EnqueueAll(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SyncOnce(context.Background()); err != nil {
		t.Fatal(err)
	}

	totalNet := int64(0)
	for ci, c := range tr.clients {
		net := ok[ci].Load() - refunded[ci].Load()
		totalNet += net
		if ok[ci].Load()+insufficient[ci].Load() != workers/2 {
			t.Fatalf("client %d: outcomes don't add up", ci)
		}
		if ok[ci].Load() < clientBal/clientAmt {
			t.Fatalf("client %d: only %d debits succeeded, expected at least %d", ci, ok[ci].Load(), clientBal/clientAmt)
		}
		want := clientBal - net*clientAmt
		info, err := b.Peek(context.Background(), r, c)
		if err != nil || info.Balance != want || info.Balance < 0 {
			t.Fatalf("client %d redis %+v want %d (%v)", ci, info, want, err)
		}
		if bal, _ := pgBalance(t, pool, c); bal != want {
			t.Fatalf("client %d pg %d want %d", ci, bal, want)
		}
	}
	wantR := resellerBal - totalNet*resellerAmt
	if info, _ := b.Peek(context.Background(), r, r); info.Balance != wantR {
		t.Fatalf("reseller redis %d want %d", info.Balance, wantR)
	}
	if bal, _ := pgBalance(t, pool, r); bal != wantR {
		t.Fatalf("reseller pg %d want %d", bal, wantR)
	}
}

// Many goroutines hit a not-yet-loaded balance at once: hydration happens
// concurrently but load.lua's no-clobber + the row lock mean the balance is
// loaded once and every debit is accounted.
func TestConcurrentHydration(t *testing.T) {
	pool, rdb := testEnv(t)
	tr := newTree(t, pool, 0, 1_000)
	cleanupKeys(t, rdb, tr)
	b := newBiller(t, pool, rdb)
	c, r := tr.clients[0], tr.reseller
	var wg sync.WaitGroup
	var okN atomic.Int64
	for i := 0; i < 200; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, err := b.Debit(context.Background(), fmt.Sprintf("h-%d", i), []Leg{{c, r, 7}})
			if err == nil {
				okN.Add(1)
			} else if policy.CodeOf(err) != policy.CodeInsufficientFunds {
				t.Errorf("debit: %v", err)
			}
		}(i)
	}
	wg.Wait()
	if okN.Load() != 1_000/7 {
		t.Fatalf("succeeded %d want %d", okN.Load(), 1_000/7)
	}
	if info, _ := b.Peek(context.Background(), r, c); info.Balance != 1_000-7*(1_000/7) {
		t.Fatalf("balance %+v", info)
	}
}

func TestSyncerNeverWritesOlderValue(t *testing.T) {
	pool, rdb := testEnv(t)
	tr := newTree(t, pool, 0, 1_000)
	cleanupKeys(t, rdb, tr)
	b := newBiller(t, pool, rdb)
	ctx := context.Background()
	c, r := tr.clients[0], tr.reseller
	if _, err := b.Debit(ctx, "o1", []Leg{{c, r, 100}}); err != nil {
		t.Fatal(err)
	}
	// Simulate a newer write by another instance.
	future := time.Now().Add(time.Hour)
	if _, err := pool.Exec(ctx, `UPDATE accounts_balance SET balance_micros = 1, synced_at = $2 WHERE org_id = $1`, c, future); err != nil {
		t.Fatal(err)
	}
	s := NewSyncer(b, SyncerOptions{FullEvery: -1})
	if n, err := s.SyncOnce(ctx); err != nil || n != 0 {
		t.Fatalf("expected no write over newer synced_at: %d %v", n, err)
	}
	if bal, _ := pgBalance(t, pool, c); bal != 1 {
		t.Fatalf("older value written: %d", bal)
	}
	// Normal case: a lost dirty marker is recovered by the full sweep.
	if _, err := pool.Exec(ctx, `UPDATE accounts_balance SET synced_at = NULL WHERE org_id = $1`, c); err != nil {
		t.Fatal(err)
	}
	rdb.Del(ctx, b.dirtyKey)
	if err := s.EnqueueAll(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SyncOnce(ctx); err != nil {
		t.Fatal(err)
	}
	if bal, _ := pgBalance(t, pool, c); bal != 900 {
		t.Fatalf("full sweep: %d", bal)
	}
	if n, _ := rdb.SCard(ctx, b.dirtyKey).Result(); n != 0 {
		t.Fatalf("dirty set not drained: %d", n)
	}
}

func TestSyncerRequeuesOnFailure(t *testing.T) {
	pool, rdb := testEnv(t)
	tr := newTree(t, pool, 0, 1_000)
	cleanupKeys(t, rdb, tr)
	b := newBiller(t, pool, rdb)
	ctx := context.Background()
	c, r := tr.clients[0], tr.reseller
	if _, err := b.Debit(ctx, "f1", []Leg{{c, r, 100}}); err != nil {
		t.Fatal(err)
	}
	// A malformed member and a cancelled context: the PG write fails, the
	// valid member must be back in the set.
	rdb.SAdd(ctx, b.dirtyKey, "garbage")
	cctx, cancel := context.WithCancel(ctx)
	s := NewSyncer(b, SyncerOptions{FullEvery: -1})
	pool2Closed, _ := pgxpool.New(ctx, pool.Config().ConnString())
	pool2Closed.Close()
	broken := &Biller{rdb: b.rdb, pool: pool2Closed, dirtyKey: b.dirtyKey, log: b.log}
	if _, err := NewSyncer(broken, SyncerOptions{FullEvery: -1}).SyncOnce(cctx); err == nil {
		t.Fatal("expected failure with closed pool")
	}
	cancel()
	if ok, _ := rdb.SIsMember(ctx, b.dirtyKey, dirtyMember(r, c)).Result(); !ok {
		t.Fatal("member lost after failed sync")
	}
	if n, err := s.SyncOnce(ctx); err != nil || n != 1 {
		t.Fatalf("recovery sync %d %v", n, err)
	}
	if bal, _ := pgBalance(t, pool, c); bal != 900 {
		t.Fatalf("pg %d", bal)
	}
}

// runScript must work for a script whose SHA was never loaded on the server
// (EVALSHA -> NOSCRIPT -> EVAL fallback).
func TestNoScriptFallback(t *testing.T) {
	_, rdb := testEnv(t)
	src := fmt.Sprintf("-- %s\nreturn {1, 'OK', ARGV[1]}", uuid.NewString())
	s := redis.NewScript(src)
	if ok, _ := rdb.ScriptExists(context.Background(), s.Hash()).Result(); len(ok) == 1 && ok[0] {
		t.Fatal("script unexpectedly cached")
	}
	res, err := runScript(context.Background(), rdb, s, []string{"k"}, []any{"42"})
	if err != nil || res.status != "OK" || res.arg(0) != "42" {
		t.Fatalf("%+v %v", res, err)
	}
	if ok, _ := rdb.ScriptExists(context.Background(), s.Hash()).Result(); !ok[0] {
		t.Fatal("EVAL fallback did not cache the script")
	}
}
