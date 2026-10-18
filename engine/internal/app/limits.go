package app

import (
	"context"
	"log/slog"
	"time"

	"smsgw/engine/internal/billing"
	"smsgw/engine/internal/store"
)

// limitUpdates returns the overdraft limits to push into loaded Redis
// balances after a configuration reload: every billable org whose
// billing_mode / credit_limit_micros changed between old and cur, or every
// billable org when old is nil (startup: a balance hash can outlive an
// engine restart, and the limit may have changed while it was down).
func limitUpdates(old, cur *store.Snapshot) []billing.LimitUpdate {
	if cur == nil {
		return nil
	}
	var out []billing.LimitUpdate
	for _, o := range cur.Orgs() {
		if o.Role == store.RoleSuperAdmin || o.Account == nil {
			continue
		}
		limit := o.Account.OverdraftLimit()
		if old != nil {
			if prev := old.Org(o.ID); prev != nil && prev.Account != nil && prev.Account.OverdraftLimit() == limit {
				continue
			}
		}
		tag, ok := cur.BalanceTag(o.ID)
		if !ok {
			continue
		}
		out = append(out, billing.LimitUpdate{Tag: tag, OrgID: o.ID, Limit: limit})
	}
	return out
}

// syncLimits keeps the "limit" field of loaded balances equal to
// accounts_balance (CONTRACTS §6: billing_mode / credit_limit_micros changes
// are published as cfg:invalidate accounts_balance). Without it a loaded
// balance would keep the limit it was hydrated with until evicted.
func syncLimits(ctx context.Context, st *store.Store, b *billing.Biller, log *slog.Logger) {
	notify := st.Notify()
	var applied *store.Snapshot // last snapshot whose limits are in Redis
	t := time.NewTicker(5 * time.Second)
	defer t.Stop()
	for {
		if cur := st.Current(); cur != nil && cur != applied {
			ups := limitUpdates(applied, cur)
			if len(ups) == 0 {
				applied = cur
			} else {
				cctx, cancel := context.WithTimeout(ctx, 30*time.Second)
				n, err := b.SetLimits(cctx, ups)
				cancel()
				if err != nil {
					// Keep the previous snapshot as the baseline: retried next tick.
					if ctx.Err() == nil {
						log.Warn("applying credit limits to loaded balances failed; will retry", "err", err)
					}
				} else {
					applied = cur
					if n > 0 {
						log.Info("credit limits applied to loaded balances", "updated", n, "checked", len(ups))
					}
				}
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-notify:
		case <-t.C:
		}
	}
}
