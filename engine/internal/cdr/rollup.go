package cdr

import (
	"context"
	"fmt"
	"sort"
	"time"

	"github.com/jackc/pgx/v5"
)

// Rollup semantics (message_stats_hourly), keyed by the hour of the
// message's created_at (UTC), org, route and destination country:
//
//	messages, parts          counted once when the CDR is inserted
//	submitted                +1 when submitted_at first becomes non-NULL
//	delivered … expired      the message's CURRENT final status: moving
//	                         from one final status to another moves the
//	                         count (no double counting)
//	client/reseller_cost     charged amount; a full refund (refunded=true)
//	                         removes it, a reduced cost (partial refund)
//	                         applies the difference
//	route_cost               upstream cost, updated by difference
type rollupKey struct {
	bucket  int64 // unix seconds of the hour
	org     string
	route   string
	country string
}

type rollupVal struct {
	reseller                                                             *string
	messages, parts, submitted, delivered, undelivered, failed, rejected int64
	expired, clientCost, resellerCost, routeCost                         int64
}

func (v *rollupVal) zero() bool {
	return v.messages == 0 && v.parts == 0 && v.submitted == 0 && v.delivered == 0 && v.undelivered == 0 &&
		v.failed == 0 && v.rejected == 0 && v.expired == 0 && v.clientCost == 0 && v.resellerCost == 0 && v.routeCost == 0
}

type rollups map[rollupKey]*rollupVal

func bucketOf(t time.Time) int64 { return t.UTC().Truncate(time.Hour).Unix() }

func countryOr(c *string) string {
	if c == nil || *c == "" {
		return "--"
	}
	return *c
}

func (r rollups) get(created time.Time, org, route, country string, reseller *string) *rollupVal {
	k := rollupKey{bucketOf(created), org, route, country}
	v := r[k]
	if v == nil {
		v = &rollupVal{reseller: reseller}
		r[k] = v
	}
	if v.reseller == nil && reseller != nil {
		v.reseller = reseller
	}
	return v
}

func (v *rollupVal) status(status string, d int64) {
	switch status {
	case StatusDelivered:
		v.delivered += d
	case StatusUndelivered:
		v.undelivered += d
	case StatusFailed:
		v.failed += d
	case StatusRejected:
		v.rejected += d
	case StatusExpired:
		v.expired += d
	}
}

func val(p *int64) int64 {
	if p == nil {
		return 0
	}
	return *p
}

func charged(p *int64, refunded bool) int64 {
	if refunded {
		return 0
	}
	return val(p)
}

func (r rollups) addInsert(rec *Record) {
	if rec.RouteID == "" {
		return
	}
	var res *string
	if rec.ResellerID != "" {
		s := rec.ResellerID
		res = &s
	}
	c := rec.CountryISO
	v := r.get(rec.CreatedAt, rec.OrgID, rec.RouteID, countryOr(&c), res)
	v.messages++
	v.parts += int64(rec.Parts)
	if rec.SubmittedAt != nil {
		v.submitted++
	}
	v.status(rec.Status, 1)
	v.clientCost += charged(rec.ClientCostMicros, rec.Refunded)
	v.resellerCost += charged(rec.ResellerCostMicros, rec.Refunded)
	v.routeCost += val(rec.RouteCostMicros)
}

func (r rollups) addChange(old, next *row) {
	if old.RouteID == nil || *old.RouteID == "" {
		return
	}
	v := r.get(old.CreatedAt, old.OrgID, *old.RouteID, countryOr(old.CountryISO), old.ResellerID)
	if old.SubmittedAt == nil && next.SubmittedAt != nil {
		v.submitted++
	}
	if old.Status != next.Status {
		v.status(old.Status, -1)
		v.status(next.Status, 1)
	}
	v.clientCost += charged(next.ClientCost, next.Refunded) - charged(old.ClientCost, old.Refunded)
	v.resellerCost += charged(next.ResellerCost, next.Refunded) - charged(old.ResellerCost, old.Refunded)
	v.routeCost += val(next.RouteCost) - val(old.RouteCost)
}

const rollupSQL = `
INSERT INTO message_stats_hourly AS s (
  bucket, org_id, reseller_id, route_id, country_iso, messages, parts, submitted, delivered,
  undelivered, failed, rejected, expired, client_cost_micros, reseller_cost_micros, route_cost_micros)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
ON CONFLICT (bucket, org_id, route_id, country_iso) DO UPDATE SET
  reseller_id          = coalesce(s.reseller_id, EXCLUDED.reseller_id),
  messages             = s.messages + EXCLUDED.messages,
  parts                = s.parts + EXCLUDED.parts,
  submitted            = s.submitted + EXCLUDED.submitted,
  delivered            = s.delivered + EXCLUDED.delivered,
  undelivered          = s.undelivered + EXCLUDED.undelivered,
  failed               = s.failed + EXCLUDED.failed,
  rejected             = s.rejected + EXCLUDED.rejected,
  expired              = s.expired + EXCLUDED.expired,
  client_cost_micros   = s.client_cost_micros + EXCLUDED.client_cost_micros,
  reseller_cost_micros = s.reseller_cost_micros + EXCLUDED.reseller_cost_micros,
  route_cost_micros    = s.route_cost_micros + EXCLUDED.route_cost_micros`

func (r rollups) write(ctx context.Context, tx pgx.Tx) error {
	keys := make([]rollupKey, 0, len(r))
	for k, v := range r {
		if !v.zero() {
			keys = append(keys, k)
		}
	}
	if len(keys) == 0 {
		return nil
	}
	// Deterministic order so concurrent writers lock rollup rows in the
	// same sequence (no deadlocks).
	sort.Slice(keys, func(i, j int) bool {
		a, b := keys[i], keys[j]
		if a.bucket != b.bucket {
			return a.bucket < b.bucket
		}
		if a.org != b.org {
			return a.org < b.org
		}
		if a.route != b.route {
			return a.route < b.route
		}
		return a.country < b.country
	})
	b := &pgx.Batch{}
	for _, k := range keys {
		v := r[k]
		b.Queue(rollupSQL, time.Unix(k.bucket, 0).UTC(), k.org, v.reseller, k.route, k.country,
			v.messages, v.parts, v.submitted, v.delivered, v.undelivered, v.failed, v.rejected, v.expired,
			v.clientCost, v.resellerCost, v.routeCost)
	}
	br := tx.SendBatch(ctx, b)
	for range keys {
		if _, err := br.Exec(); err != nil {
			br.Close()
			return fmt.Errorf("cdr: rollup: %w", err)
		}
	}
	if err := br.Close(); err != nil {
		return fmt.Errorf("cdr: rollup batch: %w", err)
	}
	return nil
}
