package routing

import (
	"errors"
	"math"
	"math/rand/v2"
	"testing"

	"smsgw/engine/internal/policy"
	"smsgw/engine/internal/store"
)

const (
	admin, res, res2, cli, cli2, cliB = "a0", "r1", "r2", "c1", "c2", "cb"
	k1, k2, k3, k4, k5                = "k1", "k2", "k3", "k4", "k5"
	rt1, rt2, rt3, rt4, rt5, rt6      = "rt1", "rt2", "rt3", "rt4", "rt5", "rt6"
)

func org(id, role, parent string) *store.Org {
	return &store.Org{ID: id, Role: role, ParentID: parent, Status: "ACTIVE", MaxTPS: 10,
		Effective: store.Effective{IsActive: true, CanSend: true, CanAPI: true, EffectiveMaxTPS: 10}}
}

func conn(id string, enabled bool) *store.Connection {
	return &store.Connection{ID: id, Name: id, Enabled: enabled}
}

func asg(id, orgID, route, prefix string, rate int64, prio int, enabled bool) *store.Assignment {
	return &store.Assignment{ID: id, OrgID: orgID, RouteID: route, Prefix: prefix, RateMicros: rate, Priority: prio, Enabled: enabled}
}

func rc(route, c string, prio, weight int, enabled bool) *store.RouteConnection {
	return &store.RouteConnection{RouteID: route, ConnectionID: c, Priority: prio, Weight: weight, Enabled: enabled}
}

func fixture() *store.Snapshot {
	badPw := conn(k4, true)
	badPw.PasswordErr = errors.New("decrypt failed")
	d := store.Data{
		Orgs: []*store.Org{
			org(admin, store.RoleSuperAdmin, ""),
			org(res, store.RoleReseller, admin),
			org(res2, store.RoleReseller, admin),
			org(cli, store.RoleClient, res),
			org(cli2, store.RoleClient, res),
			org(cliB, store.RoleClient, res2),
		},
		Connections: []*store.Connection{conn(k1, true), conn(k2, true), conn(k3, false), badPw, conn(k5, true)},
		Rates: []*store.Rate{
			{ConnectionID: k1, Prefix: "", CostMicros: 10},
			{ConnectionID: k1, Prefix: "91", CostMicros: 8},
			{ConnectionID: k1, Prefix: "9198", CostMicros: 6},
			{ConnectionID: k2, Prefix: "44", CostMicros: 12},
		},
		Routes: []*store.Route{
			{ID: rt1, Name: "rt1", Enabled: true},
			{ID: rt2, Name: "rt2", Enabled: true}, // only disabled / undecryptable connections
			{ID: rt3, Name: "rt3", Enabled: false},
			{ID: rt4, Name: "rt4", Enabled: true},
			{ID: rt5, Name: "rt5", Enabled: true},
			{ID: rt6, Name: "rt6", Enabled: true}, // link disabled
		},
		RouteConnections: []*store.RouteConnection{
			rc(rt1, k1, 1, 100, true), rc(rt1, k2, 1, 300, true), rc(rt1, k3, 1, 500, true), rc(rt1, k5, 2, 100, true),
			rc(rt2, k3, 1, 100, true), rc(rt2, k4, 1, 100, true),
			rc(rt3, k1, 1, 100, true),
			rc(rt4, k2, 2, 100, true), rc(rt4, k1, 1, 100, true),
			rc(rt5, k1, 1, 100, true),
			rc(rt6, k1, 1, 100, false),
		},
		Assignments: []*store.Assignment{
			// reseller r1 (admin -> reseller rates)
			asg("ra1", res, rt1, "", 50, 1, true),
			asg("ra2", res, rt1, "91", 40, 1, true),
			asg("ra3", res, rt4, "44", 30, 1, true),
			asg("ra4", res, rt2, "", 20, 1, true),
			asg("ra5", res, rt3, "", 20, 1, true),
			asg("ra6", res, rt5, "", 25, 1, false), // reseller lost rt5
			asg("ra7", res, rt4, "", 35, 1, true),
			asg("ra8", res, rt6, "", 35, 1, true),
			// client c1
			asg("ca1", cli, rt1, "", 100, 1, true),
			asg("ca2", cli, rt4, "44", 90, 1, true),
			asg("ca3", cli, rt4, "4477", 80, 2, true),
			asg("ca4", cli, rt2, "91", 70, 1, true),  // unusable route -> skipped
			asg("ca5", cli, rt3, "1", 60, 1, true),   // disabled route -> skipped
			asg("ca6", cli, rt5, "33", 55, 1, true),  // no reseller assignment -> skipped
			asg("ca7", cli, rt1, "49", 45, 1, false), // disabled assignment -> ignored
			asg("ca8", cli, rt6, "7", 45, 1, true),   // only disabled link -> skipped
			// client c2: equal prefix, priority decides
			asg("cb1", cli2, rt1, "", 100, 2, true),
			asg("cb2", cli2, rt4, "", 95, 1, true),
		},
	}
	return store.NewSnapshot(d)
}

func TestSelectRouteMatrix(t *testing.T) {
	snap := fixture()
	cases := []struct {
		name, org, dest, forced string
		route                   string
		clientRate, resRate     int64
		resNil                  bool
		code                    policy.Code
	}{
		{"unusable longer prefix skipped, reseller longest prefix", cli, "919876543210", "", rt1, 100, 40, false, ""},
		{"longest client prefix wins over priority", cli, "447700900123", "", rt4, 80, 30, false, ""},
		{"shorter prefix", cli, "447400900123", "", rt4, 90, 30, false, ""},
		{"disabled route skipped", cli, "15551234567", "", rt1, 100, 50, false, ""},
		{"missing reseller assignment skipped", cli, "33612345678", "", rt1, 100, 50, false, ""},
		{"disabled client assignment ignored", cli, "4915123456789", "", rt1, 100, 50, false, ""},
		{"route with only disabled link skipped", cli, "79161234567", "", rt1, 100, 50, false, ""},
		{"forced route restricts candidates", cli, "447700900123", rt1, rt1, 100, 50, false, ""},
		{"forced route not matching prefix", cli, "919876543210", rt4, "", 0, 0, false, policy.CodeRouteNotFound},
		{"forced unknown route", cli, "919876543210", "nope", "", 0, 0, false, policy.CodeRouteNotFound},
		{"equal prefix -> lowest priority", cli2, "447700900123", "", rt4, 95, 30, false, ""},
		{"reseller tier falls back to its catch-all prefix", cli2, "919876543210", "", rt4, 95, 35, false, ""},
		{"reseller sends itself (single tier)", res, "919876543210", "", rt1, 40, 0, true, ""},
		{"reseller longest prefix itself", res, "447700900123", "", rt4, 30, 0, true, ""},
		{"client of reseller without routes", cliB, "919876543210", "", "", 0, 0, false, policy.CodeRouteNotFound},
		{"admin without forced route", admin, "919876543210", "", "", 0, 0, false, policy.CodeRouteNotFound},
		{"admin forced (tester)", admin, "919876543210", rt1, rt1, 0, 0, true, ""},
		{"admin forced unusable", admin, "919876543210", rt2, "", 0, 0, false, policy.CodeRouteNotFound},
		{"unknown org", "ghost", "919876543210", "", "", 0, 0, false, policy.CodeUnauthorized},
	}
	for _, c := range cases {
		sel, err := SelectRoute(snap, c.org, c.dest, c.forced)
		if c.code != "" {
			if policy.CodeOf(err) != c.code {
				t.Errorf("%s: want %s, got %v (%+v)", c.name, c.code, err, sel)
			}
			continue
		}
		if err != nil {
			t.Errorf("%s: %v", c.name, err)
			continue
		}
		if sel.Route.ID != c.route || sel.ClientRate() != c.clientRate || sel.ResellerRate() != c.resRate || (sel.Reseller == nil) != c.resNil {
			t.Errorf("%s: got route=%s client=%d reseller=%d (nil=%v)", c.name, sel.Route.ID, sel.ClientRate(), sel.ResellerRate(), sel.Reseller == nil)
		}
	}
}

func TestCharges(t *testing.T) {
	sel, err := SelectRoute(fixture(), cli, "919876543210", "")
	if err != nil {
		t.Fatal(err)
	}
	if c, r := sel.Charges(3); c != 300 || r != 120 {
		t.Fatalf("charges %d %d", c, r)
	}
}

type seq struct{ vals []int }

func (s *seq) IntN(n int) int { v := s.vals[0] % n; s.vals = s.vals[1:]; return v }

func ids(cs []*store.Connection) []string {
	out := make([]string, len(cs))
	for i, c := range cs {
		out[i] = c.ID
	}
	return out
}

func TestConnectionCandidatesOrder(t *testing.T) {
	snap := fixture()
	// rt4: k1 prio 1, k2 prio 2.
	if got := ids(ConnectionCandidates(snap.Route(rt4), nil, nil)); len(got) != 2 || got[0] != k1 || got[1] != k2 {
		t.Fatalf("priority order: %v", got)
	}
	// Unhealthy k1 is dropped.
	healthy := func(c *store.Connection) bool { return c.ID != k1 }
	if got := ids(ConnectionCandidates(snap.Route(rt4), healthy, nil)); len(got) != 1 || got[0] != k2 {
		t.Fatalf("health filter: %v", got)
	}
	// rt1: prio 1 = {k1 w100, k2 w300} (k3 disabled), prio 2 = {k5}. Deterministic rng:
	// pick 0 -> k1 (0 < 100) then k2; pick 150 -> k2 then k1.
	if got := ids(ConnectionCandidates(snap.Route(rt1), nil, &seq{[]int{0, 0, 0}})); got[0] != k1 || got[1] != k2 || got[2] != k5 || len(got) != 3 {
		t.Fatalf("rng 0: %v", got)
	}
	if got := ids(ConnectionCandidates(snap.Route(rt1), nil, &seq{[]int{150, 0, 0}})); got[0] != k2 || got[1] != k1 || got[2] != k5 {
		t.Fatalf("rng 150: %v", got)
	}
	// rt2 only has a disabled and an undecryptable connection.
	if got := ConnectionCandidates(snap.Route(rt2), nil, nil); len(got) != 0 {
		t.Fatalf("unusable: %v", ids(got))
	}
	if got := ConnectionCandidates(snap.Route(rt6), nil, nil); len(got) != 0 {
		t.Fatalf("disabled link: %v", ids(got))
	}
	if ConnectionCandidates(nil, nil, nil) != nil {
		t.Fatal("nil route")
	}
}

func TestConnectionCandidatesWeights(t *testing.T) {
	snap := fixture()
	rng := rand.New(rand.NewPCG(1, 2))
	const trials = 20000
	first := map[string]int{}
	for i := 0; i < trials; i++ {
		c := ConnectionCandidates(snap.Route(rt1), nil, rng)
		first[c[0].ID]++
		if c[len(c)-1].ID != k5 {
			t.Fatal("lower priority must come last")
		}
	}
	share := float64(first[k2]) / trials
	if math.Abs(share-0.75) > 0.02 {
		t.Fatalf("k2 first share %.3f, want ~0.75 (%v)", share, first)
	}
}

func TestRouteCost(t *testing.T) {
	snap := fixture()
	c1 := snap.Connection(k1)
	cases := map[string]int64{"919876543210": 6, "917700000000": 8, "447700900123": 10}
	for dest, want := range cases {
		if got, _, ok := RouteCost(c1, dest); !ok || got != want {
			t.Errorf("%s: %d %v want %d", dest, got, ok, want)
		}
	}
	if _, p, ok := RouteCost(snap.Connection(k2), "447700900123"); !ok || p != "44" {
		t.Errorf("k2 44: %s %v", p, ok)
	}
	if _, _, ok := RouteCost(snap.Connection(k2), "919876543210"); ok {
		t.Error("k2 has no rate for 91")
	}
	if _, _, ok := RouteCost(nil, "1"); ok {
		t.Error("nil conn")
	}
}
