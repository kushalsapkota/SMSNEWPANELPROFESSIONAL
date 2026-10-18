package billing

import (
	"context"
	"testing"

	"github.com/google/uuid"
)

// A refund whose balance is still not loaded goes through the locked
// ledger path: missing legs are credited in Postgres, loaded legs in Redis,
// and the txn record is advanced so nothing is refunded twice.
func TestRefundUnloadedLedgerPath(t *testing.T) {
	pool, rdb := testEnv(t)
	tr := newTree(t, pool, 1000, 1000)
	cleanupKeys(t, rdb, tr)
	b := newBiller(t, pool, rdb)
	ctx := context.Background()
	client := tr.clients[0]
	legs := []Leg{{OrgID: client, Tag: tr.reseller, Amount: 100}, {OrgID: tr.reseller, Tag: tr.reseller, Amount: 50}}
	txn := uuid.NewString()
	if _, err := b.Debit(ctx, txn, legs); err != nil {
		t.Fatal(err)
	}
	if err := b.Evict(ctx, tr.reseller, client); err != nil { // client balance gone again
		t.Fatal(err)
	}
	pgBefore, _ := pgBalance(t, pool, client)
	res, err := b.RefundUnloaded(ctx, txn, legs, nil)
	if err != nil || res.Status != StatusOK || res.Refunded[0] != 100 || res.Refunded[1] != 50 {
		t.Fatalf("%+v %v", res, err)
	}
	if after, _ := pgBalance(t, pool, client); after != pgBefore+100 {
		t.Fatalf("ledger credit: %d -> %d", pgBefore, after)
	}
	if info, _ := b.Peek(ctx, tr.reseller, tr.reseller); info.Balance != 1000 {
		t.Fatalf("loaded leg credited in Redis: %d", info.Balance)
	}
	var n int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM balance_transactions WHERE idempotency_key = $1 AND type = 'REFUND'`,
		"refund:"+txn+":"+client).Scan(&n); err != nil || n != 1 {
		t.Fatalf("ledger rows %d %v", n, err)
	}
	if r1, _ := rdb.HGet(ctx, TxnKey(tr.reseller, txn), "r1").Int64(); r1 != 100 {
		t.Fatalf("txn r1 %d", r1)
	}
	// Never twice, whichever path runs next.
	if res, err := b.RefundUnloaded(ctx, txn, legs, nil); err != nil || res.Status != StatusNothingToRefund {
		t.Fatalf("second: %+v %v", res, err)
	}
	if res, err := b.Refund(ctx, txn, legs, nil); err != nil || res.Status != StatusNothingToRefund {
		t.Fatalf("refund.lua after ledger refund: %+v %v", res, err)
	}
	if after, _ := pgBalance(t, pool, client); after != pgBefore+100 {
		t.Fatal("refunded twice")
	}
}

// If hydration completed before the locks were taken, the refund goes to
// Redis through refund.lua (no ledger row that the syncer would overwrite).
func TestRefundUnloadedUsesRedisWhenLoadedMeanwhile(t *testing.T) {
	pool, rdb := testEnv(t)
	tr := newTree(t, pool, 1000, 1000)
	cleanupKeys(t, rdb, tr)
	b := newBiller(t, pool, rdb)
	ctx := context.Background()
	legs := []Leg{{OrgID: tr.clients[0], Tag: tr.reseller, Amount: 30}, {OrgID: tr.reseller, Tag: tr.reseller, Amount: 10}}
	txn := uuid.NewString()
	if _, err := b.Debit(ctx, txn, legs); err != nil {
		t.Fatal(err)
	}
	res, err := b.RefundUnloaded(ctx, txn, legs, []int64{30, 10})
	if err != nil || res.Status != StatusOK {
		t.Fatalf("%+v %v", res, err)
	}
	if info, _ := b.Peek(ctx, tr.reseller, tr.clients[0]); info.Balance != 1000 {
		t.Fatalf("redis balance %d", info.Balance)
	}
	var n int
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM balance_transactions WHERE reference = $1`, txn).Scan(&n)
	if n != 0 {
		t.Fatal("ledger row written although the balance was loaded")
	}
}

func TestSetLimits(t *testing.T) {
	pool, rdb := testEnv(t)
	tr := newTree(t, pool, 1000, 0, 0)
	cleanupKeys(t, rdb, tr)
	b := newBiller(t, pool, rdb)
	ctx := context.Background()
	if _, err := b.Load(ctx, tr.reseller, tr.clients[0]); err != nil {
		t.Fatal(err)
	}
	n, err := b.SetLimits(ctx, []LimitUpdate{{Tag: tr.reseller, OrgID: tr.clients[0], Limit: 500}, {Tag: tr.reseller, OrgID: tr.clients[1], Limit: 700}})
	if err != nil || n != 1 {
		t.Fatalf("updated %d %v", n, err)
	}
	if info, _ := b.Peek(ctx, tr.reseller, tr.clients[0]); info.Limit != 500 {
		t.Fatalf("limit %d", info.Limit)
	}
	if info, _ := b.Peek(ctx, tr.reseller, tr.clients[1]); info.Loaded {
		t.Fatal("SetLimits must not create unloaded balances")
	}
	// The new limit is enforced by debit.lua.
	if _, err := b.Debit(ctx, uuid.NewString(), []Leg{{OrgID: tr.clients[0], Tag: tr.reseller, Amount: 400}}); err != nil {
		t.Fatalf("debit within the new credit line: %v", err)
	}
}
