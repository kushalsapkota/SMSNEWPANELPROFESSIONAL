// Package routing selects the route and rates for a destination
// (CONTRACTS §9 step 4 and §8) and orders upstream connections for the
// dispatcher. All functions are pure over an immutable *store.Snapshot and
// safe for concurrent use.
package routing

import (
	"math/rand/v2"
	"strings"

	"smsgw/engine/internal/policy"
	"smsgw/engine/internal/store"
)

// Selection is the routing decision for one message.
type Selection struct {
	Route *store.Route
	// Client is the sending org's matched assignment (for a RESELLER sending
	// itself this is the reseller's own assignment). nil for SUPER_ADMIN
	// tester traffic on a forced route.
	Client *store.Assignment
	// Reseller is the reseller's assignment for the same route, longest
	// prefix matching the destination. nil when the sender is a RESELLER
	// (single debit) or SUPER_ADMIN (never billed).
	Reseller *store.Assignment
}

// ClientRate is the per-segment rate charged to the sending org (0 if none).
func (s *Selection) ClientRate() int64 {
	if s.Client == nil {
		return 0
	}
	return s.Client.RateMicros
}

// ResellerRate is the per-segment rate charged to the reseller tier (0 if none).
func (s *Selection) ResellerRate() int64 {
	if s.Reseller == nil {
		return 0
	}
	return s.Reseller.RateMicros
}

// Charges returns (client cost, reseller cost) for a message of n parts
// (CONTRACTS §8: rate × parts).
func (s *Selection) Charges(parts int) (client, reseller int64) {
	return s.ClientRate() * int64(parts), s.ResellerRate() * int64(parts)
}

// SelectRoute picks the route for clientOrgID → destination (normalized
// digits). Candidates are the org's ENABLED assignments whose prefix is a
// prefix of destination, restricted to forcedRouteID when non-empty,
// ordered by longest prefix then lowest priority (then route id for
// determinism). The first candidate whose route is enabled, has at least
// one usable connection and — for a CLIENT — has a matching enabled
// reseller assignment on the same route wins. A candidate failing any of
// those is skipped (falls through to the next). No candidate →
// ROUTE_NOT_FOUND.
//
// SUPER_ADMIN has no assignments: it may only send on a forced route
// (tester), which must be enabled and usable; Client/Reseller are nil.
func SelectRoute(snap *store.Snapshot, clientOrgID, destination, forcedRouteID string) (*Selection, error) {
	org := snap.Org(clientOrgID)
	if org == nil {
		return nil, policy.New(policy.CodeUnauthorized, "unknown organization")
	}
	if org.Role == store.RoleSuperAdmin {
		if forcedRouteID == "" {
			return nil, policy.New(policy.CodeRouteNotFound, "no route assigned")
		}
		r := snap.Route(forcedRouteID)
		if r == nil || !r.Enabled || !r.HasUsableConnection() {
			return nil, policy.New(policy.CodeRouteNotFound, "route unavailable")
		}
		return &Selection{Route: r}, nil
	}

	var reseller *store.Org
	if org.Role == store.RoleClient {
		reseller = snap.Parent(org.ID)
		if reseller == nil || reseller.Role != store.RoleReseller {
			return nil, policy.New(policy.CodeRouteNotFound, "no route available")
		}
	}

	for _, a := range snap.Assignments(org.ID) {
		if !a.Enabled || !strings.HasPrefix(destination, a.Prefix) {
			continue
		}
		if forcedRouteID != "" && a.RouteID != forcedRouteID {
			continue
		}
		r := snap.Route(a.RouteID)
		if r == nil || !r.Enabled || !r.HasUsableConnection() {
			continue
		}
		sel := &Selection{Route: r, Client: a}
		if reseller != nil {
			sel.Reseller = BestAssignment(snap.Assignments(reseller.ID), r.ID, destination)
			if sel.Reseller == nil {
				continue
			}
		}
		return sel, nil
	}
	if forcedRouteID != "" {
		return nil, policy.New(policy.CodeRouteNotFound, "route is not available for this destination")
	}
	return nil, policy.New(policy.CodeRouteNotFound, "no route for destination")
}

// BestAssignment returns the enabled assignment on routeID with the longest
// prefix matching destination (lowest priority on ties), or nil. list must be
// sorted as store.Snapshot.Assignments returns it.
func BestAssignment(list []*store.Assignment, routeID, destination string) *store.Assignment {
	for _, a := range list {
		if a.Enabled && a.RouteID == routeID && strings.HasPrefix(destination, a.Prefix) {
			return a
		}
	}
	return nil
}

// Rand is the randomness source for weighted selection; *rand.Rand from
// math/rand/v2 satisfies it. Implementations used concurrently must be
// concurrency-safe.
type Rand interface {
	IntN(n int) int
}

type globalRand struct{}

func (globalRand) IntN(n int) int { return rand.IntN(n) }

// ConnectionCandidates returns the route's usable connections in try order:
// ascending priority; within one priority a weighted random permutation
// (probability of being first ∝ weight). A connection is usable when its
// route link and the connection are enabled, its password decrypted, and
// isHealthy (nil = all healthy) returns true. rng nil uses math/rand/v2's
// global source.
func ConnectionCandidates(route *store.Route, isHealthy func(*store.Connection) bool, rng Rand) []*store.Connection {
	if route == nil {
		return nil
	}
	if rng == nil {
		rng = globalRand{}
	}
	out := make([]*store.Connection, 0, len(route.Connections))
	// route.Connections is sorted by priority; process one priority group at a time.
	group := make([]*store.RouteConnection, 0, len(route.Connections))
	flush := func() {
		for len(group) > 0 {
			total := 0
			for _, rc := range group {
				total += weightOf(rc)
			}
			pick := rng.IntN(total)
			idx := 0
			for i, rc := range group {
				pick -= weightOf(rc)
				if pick < 0 {
					idx = i
					break
				}
			}
			out = append(out, group[idx].Connection)
			group = append(group[:idx], group[idx+1:]...)
		}
	}
	prio := 0
	for _, rc := range route.Connections {
		if !rc.Usable() || (isHealthy != nil && !isHealthy(rc.Connection)) {
			continue
		}
		if len(group) > 0 && rc.Priority != prio {
			flush()
		}
		prio = rc.Priority
		group = append(group, rc)
	}
	flush()
	return out
}

func weightOf(rc *store.RouteConnection) int {
	if rc.Weight <= 0 {
		return 1
	}
	return rc.Weight
}

// RouteCost returns the upstream cost per segment for destination on conn:
// the currently effective upstream_rates row with the longest matching
// prefix. ok=false when the connection has no matching rate (cost unknown;
// record NULL route_cost_micros).
func RouteCost(conn *store.Connection, destination string) (costMicros int64, prefix string, ok bool) {
	if conn == nil {
		return 0, "", false
	}
	for _, r := range conn.Rates { // longest prefix first
		if strings.HasPrefix(destination, r.Prefix) {
			return r.CostMicros, r.Prefix, true
		}
	}
	return 0, "", false
}
