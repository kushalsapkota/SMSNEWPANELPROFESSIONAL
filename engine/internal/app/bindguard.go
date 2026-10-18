package app

import (
	"sync"
	"time"
)

// bindGuard counts failed SMPP bind attempts per remote IP and per
// system_id in fixed windows and blocks further password checks (argon2)
// for a key that exceeded its budget until its window ends. It bounds both
// password guessing and the CPU an unauthenticated caller can make the
// server spend. Binds whose credentials verified recently (bind cache) are
// never blocked, so a locked system_id does not lock out its owner's
// existing clients.
type bindGuard struct {
	window   time.Duration
	maxPerIP int
	maxPerID int
	now      func() time.Time

	mu      sync.Mutex
	entries map[string]*guardEntry
	sweepAt time.Time
}

type guardEntry struct {
	start time.Time
	fails int
}

func newBindGuard(window time.Duration, maxPerIP, maxPerID int) *bindGuard {
	return &bindGuard{window: window, maxPerIP: maxPerIP, maxPerID: maxPerID, now: time.Now, entries: map[string]*guardEntry{}}
}

func (g *bindGuard) count(key string, now time.Time) int {
	e := g.entries[key]
	if e == nil || now.Sub(e.start) >= g.window {
		return 0
	}
	return e.fails
}

// blocked reports whether ip or systemID used up its failure budget.
func (g *bindGuard) blocked(ip, systemID string) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	now := g.now()
	return g.count("ip|"+ip, now) >= g.maxPerIP || (systemID != "" && g.count("id|"+systemID, now) >= g.maxPerID)
}

// fail records a failed attempt for ip and (if known) systemID.
func (g *bindGuard) fail(ip, systemID string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	now := g.now()
	g.incr("ip|"+ip, now)
	if systemID != "" {
		g.incr("id|"+systemID, now)
	}
	if now.After(g.sweepAt) {
		for k, e := range g.entries {
			if now.Sub(e.start) >= g.window {
				delete(g.entries, k)
			}
		}
		g.sweepAt = now.Add(g.window)
	}
}

func (g *bindGuard) incr(key string, now time.Time) {
	e := g.entries[key]
	if e == nil || now.Sub(e.start) >= g.window {
		e = &guardEntry{start: now}
		g.entries[key] = e
	}
	e.fails++
}
