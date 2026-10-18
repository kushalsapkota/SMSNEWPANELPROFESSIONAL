package e2e

import (
	"context"
	"testing"
	"time"
)

// A billing_mode / credit_limit change reaches a balance that is already
// loaded in Redis (CONTRACTS §6 accounts_balance invalidation).
func TestCreditLimitChangeReachesLoadedBalance(t *testing.T) {
	ctx := context.Background()
	org := w.ids.poor
	limitOf := func() int64 {
		var b struct {
			Limit int64 `json:"credit_limit_micros"`
		}
		if st, err := call("GET", "/internal/v1/balance/"+org, nil, &b); err != nil || st != 200 {
			t.Fatalf("balance: %d %v", st, err)
		}
		return b.Limit
	}
	setMode := func(mode string, limit int64) {
		t.Helper()
		if _, err := w.pool.Exec(ctx, `UPDATE accounts_balance SET billing_mode = $2, credit_limit_micros = $3 WHERE org_id = $1`, org, mode, limit); err != nil {
			t.Fatal(err)
		}
		if err := w.app.Redis().Publish(ctx, w.invalidate, `{"entity":"accounts_balance","id":"`+org+`"}`).Err(); err != nil {
			t.Fatal(err)
		}
	}
	t.Cleanup(func() { setMode("PREPAID", 0) })
	if limitOf() != 0 { // hydrated now, prepaid
		t.Fatal("unexpected initial limit")
	}
	setMode("POSTPAID", 5_000_000)
	waitFor(t, "raised limit applied to the loaded balance", 10*time.Second, func() bool { return limitOf() == 5_000_000 })
	st, r := submit(t, map[string]any{"org_id": org, "source": "MYBANK", "destination": "44" + randDigits(9), "text": "on credit"})
	if st != 200 {
		t.Fatalf("send within the new credit line: %d %+v", st, r)
	}
	setMode("PREPAID", 0)
	waitFor(t, "credit line removed from the loaded balance", 10*time.Second, func() bool { return limitOf() == 0 })
}
