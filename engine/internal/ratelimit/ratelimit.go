// Package ratelimit enforces per-org velocity limits (CONTRACTS §9 step 8)
// with one atomic Redis script: a 1-second TPS window plus daily and monthly
// message counters. Either every counter is incremented or none is.
//
// Keys (CONTRACTS §7):
//
//	rl:org:<org_id>:<unix_sec>     TPS window, TTL 2s
//	cnt:d:<org_id>:<YYYYMMDD>      daily counter, TTL until local end of day + 1h
//	cnt:m:<org_id>:<YYYYMM>        monthly counter, TTL until local end of month + 1d
//
// Day and month boundaries are computed in the org's IANA timezone
// (organizations.timezone); an unknown zone falls back to UTC. The TPS
// window uses the engine host clock (Unix seconds), so engine hosts must be
// NTP-synchronized; skew between instances only shifts window boundaries.
//
// The script touches three keys without a shared hash tag, so it requires a
// non-cluster Redis (or a cluster proxy that routes all three to one node).
package ratelimit

import (
	"context"
	"fmt"
	"strconv"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"

	"smsgw/engine/internal/policy"
)

// checkSrc: KEYS tps, day, month[, once]; ARGV tpsLimit, dayLimit,
// monthLimit (0 = unlimited), n, tpsTTL, dayTTL, monthTTL.
//
// The optional 4th key (rl:once:<token>) makes a check idempotent: go-redis
// re-sends a script after a read timeout, and without it a retry of a check
// that already ran would count the message twice. The first run stores its
// reply there for 60s and a replay returns it unchanged.
const checkSrc = `
local once = KEYS[4]
if once then
  local prev = redis.call('GET', once)
  if prev then
    local r = {}
    for v in string.gmatch(prev, '[^|]+') do r[#r + 1] = v end
    if r[1] == 'OK' then return {1, 'OK', tonumber(r[2]), tonumber(r[3]), tonumber(r[4]), 1} end
    return {0, r[1], tonumber(r[2])}
  end
end
local n = tonumber(ARGV[4])
local lim = {tonumber(ARGV[1]), tonumber(ARGV[2]), tonumber(ARGV[3])}
local codes = {'RATE_LIMITED', 'DAILY_LIMIT', 'MONTHLY_LIMIT'}
local cur = {}
for i = 1, 3 do
  cur[i] = tonumber(redis.call('GET', KEYS[i]) or '0')
  if lim[i] > 0 and cur[i] + n > lim[i] then
    if once then redis.call('SET', once, codes[i] .. '|' .. cur[i], 'EX', 60) end
    return {0, codes[i], cur[i]}
  end
end
local res = {1, 'OK'}
for i = 1, 3 do
  res[#res + 1] = redis.call('INCRBY', KEYS[i], n)
  if redis.call('TTL', KEYS[i]) < 0 then
    redis.call('EXPIRE', KEYS[i], ARGV[4 + i])
  end
end
if once then redis.call('SET', once, 'OK|' .. res[3] .. '|' .. res[4] .. '|' .. res[5], 'EX', 60) end
return res`

// releaseSrc undoes a successful Check (e.g. the debit failed afterwards).
// Counters never go below zero and missing keys are not recreated.
const releaseSrc = `
local n = tonumber(ARGV[1])
for i = 1, #KEYS do
  local v = tonumber(redis.call('GET', KEYS[i]) or '0')
  if v > 0 then
    if v <= n then redis.call('SET', KEYS[i], 0, 'KEEPTTL') else redis.call('DECRBY', KEYS[i], n) end
  end
end
return 1`

var (
	checkScript   = redis.NewScript(checkSrc)
	releaseScript = redis.NewScript(releaseSrc)
)

// Request describes one check. N is the number of messages (usually 1);
// limits <= 0 are unlimited.
type Request struct {
	OrgID        string
	TPS          int // policy.EffectiveTPS
	DailyLimit   int
	MonthlyLimit int
	Timezone     string // IANA, "" = UTC
	N            int    // default 1
	// Token (optional, e.g. the message id) makes Check idempotent for 60s:
	// a repeated Check with the same token returns the first result without
	// counting again.
	Token string
}

// Counts are the counter values after a successful Check.
type Counts struct {
	Second, Day, Month int64
	At                 time.Time // the instant the windows were computed for (pass to Release)
	// Replayed: the token's first Check already counted this message;
	// nothing was incremented now (so a Release must not decrement either).
	Replayed bool
}

// Limiter is safe for concurrent use.
type Limiter struct {
	rdb redis.UniversalClient
	now func() time.Time

	tzMu sync.RWMutex
	tz   map[string]*time.Location
}

// New creates a Limiter.
func New(rdb redis.UniversalClient) *Limiter {
	return &Limiter{rdb: rdb, now: time.Now, tz: map[string]*time.Location{"": time.UTC, "UTC": time.UTC}}
}

// WithClock overrides the clock (tests).
func (l *Limiter) WithClock(now func() time.Time) *Limiter { l.now = now; return l }

func (l *Limiter) location(name string) *time.Location {
	l.tzMu.RLock()
	loc, ok := l.tz[name]
	l.tzMu.RUnlock()
	if ok {
		return loc
	}
	loc, err := time.LoadLocation(name)
	if err != nil {
		loc = time.UTC
	}
	l.tzMu.Lock()
	l.tz[name] = loc
	l.tzMu.Unlock()
	return loc
}

// Keys returns the three counter keys for org at t in timezone tz.
func (l *Limiter) Keys(orgID, tz string, t time.Time) (tpsKey, dayKey, monthKey string) {
	lt := t.In(l.location(tz))
	return "rl:org:" + orgID + ":" + strconv.FormatInt(t.Unix(), 10),
		"cnt:d:" + orgID + ":" + lt.Format("20060102"),
		"cnt:m:" + orgID + ":" + lt.Format("200601")
}

func (l *Limiter) ttls(tz string, t time.Time) (day, month int64) {
	lt := t.In(l.location(tz))
	y, m, d := lt.Date()
	endDay := time.Date(y, m, d+1, 0, 0, 0, 0, lt.Location())
	endMonth := time.Date(y, m+1, 1, 0, 0, 0, 0, lt.Location())
	day = int64(endDay.Sub(lt)/time.Second) + 3600
	month = int64(endMonth.Sub(lt)/time.Second) + 86400
	return day, month
}

// Check atomically verifies and increments the TPS, daily and monthly
// counters. On rejection nothing is incremented and a *policy.Error with
// RATE_LIMITED, DAILY_LIMIT or MONTHLY_LIMIT is returned.
func (l *Limiter) Check(ctx context.Context, r Request) (Counts, error) {
	if r.OrgID == "" {
		return Counts{}, fmt.Errorf("ratelimit: org id required")
	}
	n := r.N
	if n <= 0 {
		n = 1
	}
	now := l.now()
	k1, k2, k3 := l.Keys(r.OrgID, r.Timezone, now)
	dayTTL, monthTTL := l.ttls(r.Timezone, now)
	keys := []string{k1, k2, k3}
	if r.Token != "" {
		keys = append(keys, "rl:once:"+r.Token)
	}
	raw, err := checkScript.Run(ctx, l.rdb, keys,
		max(r.TPS, 0), max(r.DailyLimit, 0), max(r.MonthlyLimit, 0), n, 2, dayTTL, monthTTL).Slice()
	if err != nil {
		return Counts{}, fmt.Errorf("ratelimit: %w", err)
	}
	if len(raw) < 2 {
		return Counts{}, fmt.Errorf("ratelimit: unexpected reply %v", raw)
	}
	status, _ := raw[1].(string)
	switch status {
	case "OK":
		if len(raw) != 5 && len(raw) != 6 {
			return Counts{}, fmt.Errorf("ratelimit: unexpected reply %v", raw)
		}
		c := Counts{At: now, Replayed: len(raw) == 6}
		c.Second, _ = raw[2].(int64)
		c.Day, _ = raw[3].(int64)
		c.Month, _ = raw[4].(int64)
		return c, nil
	case "RATE_LIMITED":
		return Counts{}, policy.Errorf(policy.CodeRateLimited, "rate limit of %d messages/second exceeded", r.TPS)
	case "DAILY_LIMIT":
		return Counts{}, policy.Errorf(policy.CodeDailyLimit, "daily limit of %d messages reached", r.DailyLimit)
	case "MONTHLY_LIMIT":
		return Counts{}, policy.Errorf(policy.CodeMonthlyLimit, "monthly limit of %d messages reached", r.MonthlyLimit)
	default:
		return Counts{}, fmt.Errorf("ratelimit: unexpected status %q", status)
	}
}

// Release undoes the daily and monthly increments of a successful Check made
// at time at (pass the same Request), e.g. when the debit then fails. The
// TPS window is not refunded: the attempt did consume throughput.
func (l *Limiter) Release(ctx context.Context, r Request, at time.Time) error {
	n := r.N
	if n <= 0 {
		n = 1
	}
	_, k2, k3 := l.Keys(r.OrgID, r.Timezone, at)
	if err := releaseScript.Run(ctx, l.rdb, []string{k2, k3}, n).Err(); err != nil {
		return fmt.Errorf("ratelimit: release: %w", err)
	}
	return nil
}

// Usage returns the current daily and monthly counts for org (0 if absent).
func (l *Limiter) Usage(ctx context.Context, orgID, tz string) (day, month int64, err error) {
	_, k2, k3 := l.Keys(orgID, tz, l.now())
	vals, err := l.rdb.MGet(ctx, k2, k3).Result()
	if err != nil {
		return 0, 0, fmt.Errorf("ratelimit: usage: %w", err)
	}
	parse := func(v any) int64 {
		s, _ := v.(string)
		n, _ := strconv.ParseInt(s, 10, 64)
		return n
	}
	return parse(vals[0]), parse(vals[1]), nil
}
