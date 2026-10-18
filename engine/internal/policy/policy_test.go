package policy

import (
	"errors"
	"fmt"
	"net/http"
	"net/netip"
	"testing"

	"smsgw/engine/internal/store"
)

func TestErrorBasics(t *testing.T) {
	e := Errorf(CodeRouteNotFound, "no route for %s", "91")
	if e.Error() != "ROUTE_NOT_FOUND: no route for 91" {
		t.Fatal(e.Error())
	}
	wrapped := fmt.Errorf("pipeline: %w", e)
	if CodeOf(wrapped) != CodeRouteNotFound || !errors.Is(wrapped, Sentinel(CodeRouteNotFound)) || errors.Is(wrapped, Sentinel(CodeInternal)) {
		t.Fatal("wrapping")
	}
	cause := errors.New("db down")
	w := Wrap(CodeInternal, "internal error", cause)
	if !errors.Is(w, cause) || CodeOf(errors.New("x")) != CodeInternal || CodeOf(nil) != "" {
		t.Fatal("cause/CodeOf")
	}
	if As(errors.New("boom")).Code != CodeInternal || As(nil) != nil || As(wrapped) != e {
		t.Fatal("As")
	}
	for _, c := range AllCodes {
		if !c.Valid() {
			t.Fatal(c)
		}
	}
	if len(AllCodes) != 21 || Code("NOPE").Valid() {
		t.Fatal("codes")
	}
}

func TestStatusMappings(t *testing.T) {
	httpWant := map[Code]int{
		CodeInvalidRequest: http.StatusBadRequest, CodeUnauthorized: 401, CodeForbidden: 403, CodeIPNotAllowed: 403,
		CodeNotFound: 404, CodeConflict: 409, CodeRateLimited: 429, CodeInternal: 500,
		CodeInsufficientFunds: 422, CodeDailyLimit: 422, CodeOTPNotFound: 422, CodeRouteNotFound: 422,
	}
	for c, want := range httpWant {
		if got := HTTPStatus(c); got != want {
			t.Errorf("http %s: %d want %d", c, got, want)
		}
	}
	submit := map[Code]uint32{
		CodeInsufficientFunds: 0x45, CodeOTPNotFound: 0x45, CodeRouteNotFound: 0x45, CodeDestinationBlocked: 0x45,
		CodeContentBlocked: 0x45, CodeRateLimited: 0x58, CodeDailyLimit: 0x58, CodeMonthlyLimit: 0x58,
		CodeSenderNotAllowed: 0x0A, CodeInvalidDestination: 0x0B, CodeMessageTooLong: 0x01,
		CodeAccountSuspended: 0x45, CodeSendingDisabled: 0x45, CodeChannelDisabled: 0x45, "": 0,
	}
	for c, want := range submit {
		if got := SMPPSubmitStatus(c); got != want {
			t.Errorf("submit %s: %#x want %#x", c, got, want)
		}
	}
	bind := map[Code]uint32{
		CodeAccountSuspended: 0x0F, CodeSendingDisabled: 0x0F, CodeChannelDisabled: 0x0F,
		CodeUnauthorized: 0x0E, CodeIPNotAllowed: 0x0D, "": 0,
	}
	for c, want := range bind {
		if got := SMPPBindStatus(c); got != want {
			t.Errorf("bind %s: %#x want %#x", c, got, want)
		}
	}
}

func snap() *store.Snapshot {
	mk := func(id, role, parent string) *store.Org {
		return &store.Org{ID: id, Role: role, ParentID: parent, Status: "ACTIVE", WebEnabled: true, MaxTPS: 20,
			Effective: store.Effective{IsActive: true, CanSend: true, CanAPI: true, CanSMPP: true, EffectiveMaxTPS: 20}}
	}
	c := mk("c", store.RoleClient, "r")
	stopped := mk("stopped", store.RoleClient, "r")
	stopped.Effective.CanSend, stopped.Effective.CanAPI, stopped.Effective.CanSMPP = false, false, false
	suspended := mk("sus", store.RoleClient, "r")
	suspended.Effective = store.Effective{}
	noAPI := mk("noapi", store.RoleClient, "r")
	noAPI.Effective.CanAPI = false
	return store.NewSnapshot(store.Data{
		Orgs:            []*store.Org{mk("a", store.RoleSuperAdmin, ""), mk("r", store.RoleReseller, "a"), c, stopped, suspended, noAPI},
		SenderIDs:       []*store.SenderID{{OrgID: "c", Sender: "BANK", Status: "APPROVED"}},
		BlockedNumbers:  []*store.BlockedNumber{{OrgID: "r", Prefix: "4477"}},
		BlockedKeywords: []*store.BlockedKeyword{{ID: "k", Pattern: "lottery"}},
		IPRules:         []*store.IPRule{{OrgID: "c", Prefix: netip.MustParsePrefix("10.0.0.0/8"), Scope: store.ScopeSMPP}},
		SMPPAccounts: []*store.SMPPAccount{
			{ID: "s1", OrgID: "c", SystemID: "c1", Enabled: true, AllowedBindTypes: []string{"TRX"}, MaxTPS: 5},
			{ID: "s2", OrgID: "c", SystemID: "c2", Enabled: false, AllowedBindTypes: []string{"TRX"}},
			{ID: "s3", OrgID: "sus", SystemID: "c3", Enabled: true, AllowedBindTypes: []string{"TRX"}},
		},
	})
}

func TestCheckOrg(t *testing.T) {
	s := snap()
	cases := []struct {
		org, ch string
		want    Code
	}{
		{"c", store.ChannelHTTP, ""},
		{"c", store.ChannelWeb, ""},
		{"c", store.ChannelSMPP, ""},
		{"sus", store.ChannelHTTP, CodeAccountSuspended},
		{"stopped", store.ChannelHTTP, CodeSendingDisabled},
		{"noapi", store.ChannelHTTP, CodeChannelDisabled},
		{"noapi", store.ChannelWeb, ""},
		{"ghost", store.ChannelHTTP, CodeUnauthorized},
	}
	for _, c := range cases {
		if got := CodeOf(CheckOrg(s.Org(c.org), c.ch)); got != c.want {
			t.Errorf("%s/%s: %s want %s", c.org, c.ch, got, c.want)
		}
	}
}

func TestCheckBind(t *testing.T) {
	s := snap()
	in, out := netip.MustParseAddr("10.1.1.1"), netip.MustParseAddr("8.8.8.8")
	cases := []struct {
		sys, bt string
		ip      netip.Addr
		want    Code
	}{
		{"c1", "TRX", in, ""},
		{"c1", "TX", in, CodeForbidden},
		{"c1", "TRX", out, CodeIPNotAllowed},
		{"c2", "TRX", in, CodeChannelDisabled},
		{"c3", "TRX", in, CodeAccountSuspended},
		{"nope", "TRX", in, CodeNotFound},
	}
	for _, c := range cases {
		if got := CodeOf(CheckBind(s, s.SMPPAccount(c.sys), c.bt, c.ip)); got != c.want {
			t.Errorf("%s/%s/%s: %s want %s", c.sys, c.bt, c.ip, got, c.want)
		}
	}
}

func TestSenderBlocklistTPS(t *testing.T) {
	s := snap()
	route := &store.Route{ID: "rt"}
	if got, forced, err := ResolveSender(s, "c", route, "bank"); err != nil || forced || got != "bank" {
		t.Fatalf("approved: %q %v %v", got, forced, err)
	}
	if _, _, err := ResolveSender(s, "c", route, "OTHER"); CodeOf(err) != CodeSenderNotAllowed {
		t.Fatalf("unapproved: %v", err)
	}
	if got, _, err := ResolveSender(s, "r", route, "ANY"); err != nil || got != "ANY" {
		t.Fatal("no rows -> any")
	}
	forcedRoute := &store.Route{ID: "rt", ForceSenderID: "FORCED"}
	if got, forced, err := ResolveSender(s, "c", forcedRoute, "OTHER"); err != nil || !forced || got != "FORCED" {
		t.Fatal("forced sender")
	}
	if CodeOf(CheckDestination(s, "c", "447700900123")) != CodeDestinationBlocked || CheckDestination(s, "c", "447400900123") != nil {
		t.Fatal("destination")
	}
	if CodeOf(CheckContent(s, "c", "You won the LOTTERY")) != CodeContentBlocked || CheckContent(s, "c", "hi") != nil {
		t.Fatal("content")
	}
	if EffectiveTPS(s.Org("c"), s.SMPPAccount("c1")) != 5 || EffectiveTPS(s.Org("c"), nil) != 20 || EffectiveTPS(s.Org("c"), s.SMPPAccount("c2")) != 20 {
		t.Fatal("tps")
	}
	if CodeOf(CheckIP(s, "c", netip.MustParseAddr("1.1.1.1"), store.ScopeSMPP)) != CodeIPNotAllowed || CheckIP(s, "c", netip.MustParseAddr("1.1.1.1"), store.ScopeAPI) != nil {
		t.Fatal("ip")
	}
}
