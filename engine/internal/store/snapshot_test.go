package store

import (
	"net/netip"
	"testing"

	"smsgw/engine/internal/otp"
)

func mkOrg(id, role, parent string) *Org {
	return &Org{ID: id, Role: role, ParentID: parent, Status: "ACTIVE", WebEnabled: true, APIEnabled: true,
		Effective: Effective{IsActive: true, CanSend: true, CanAPI: true}}
}

func unitSnapshot() *Snapshot {
	res := mkOrg("r", RoleReseller, "a")
	res.BrandName = "ResBrand"
	cli := mkOrg("c", RoleClient, "r")
	cli2 := mkOrg("c2", RoleClient, "r")
	cli2.BrandName = "Own"
	other := mkOrg("rx", RoleReseller, "a")
	otherCli := mkOrg("cx", RoleClient, "rx")
	return NewSnapshot(Data{
		Orgs: []*Org{mkOrg("a", RoleSuperAdmin, ""), res, cli, cli2, other, otherCli},
		Routes: []*Route{
			{ID: "rt", Name: "rt", Enabled: true},
		},
		Templates: []*Template{
			{ID: "t-default", RouteID: "rt", Template: otp.Template{Patterns: otp.DefaultPatterns, Body: "d {otp}"}},
			{ID: "t-c", RouteID: "rt", OrgID: "c", Template: otp.Template{Patterns: otp.DefaultPatterns, Body: "c {otp}"}},
			{ID: "t-bad", RouteID: "rt2", Template: otp.Template{Patterns: []string{"("}, Body: "{otp}"}},
		},
		SenderIDs: []*SenderID{
			{ID: "s1", OrgID: "c", Sender: "MyBank", Status: "APPROVED"},
			{ID: "s2", OrgID: "c", Sender: "Promo", Status: "PENDING"},
			{ID: "s3", OrgID: "c", RouteID: "rt", Sender: "+919876543210", Status: "APPROVED"},
			{ID: "s4", OrgID: "c2", Sender: "X", Status: "REJECTED"},
		},
		IPRules: []*IPRule{
			{OrgID: "c", Prefix: netip.MustParsePrefix("10.0.0.0/8"), Scope: ScopeSMPP},
			{OrgID: "c", Prefix: netip.MustParsePrefix("192.168.1.5/32"), Scope: ScopeAll},
			{OrgID: "c", Prefix: netip.MustParsePrefix("2001:db8::/32"), Scope: ScopeAPI},
		},
		BlockedNumbers: []*BlockedNumber{
			{OrgID: "", Prefix: "999"},
			{OrgID: "r", Prefix: "9198"},
			{OrgID: "c", Prefix: "447700900123"},
			{OrgID: "rx", Prefix: "33"},
		},
		BlockedKeywords: []*BlockedKeyword{
			{ID: "g", OrgID: "", Pattern: `\bbitcoin\b`},
			{ID: "rk", OrgID: "r", Pattern: "casino"},
			{ID: "ck", OrgID: "c", Pattern: "(free|win) money"},
			{ID: "bad", OrgID: "", Pattern: "("},
			{ID: "xk", OrgID: "rx", Pattern: "loan"},
		},
		SMPPAccounts: []*SMPPAccount{{ID: "sa", OrgID: "c", SystemID: "sys1", AllowedBindTypes: []string{"TX", "TRX"}}},
		Webhooks: []*Webhook{
			{ID: "w1", OrgID: "c", Events: []string{"dlr"}, Enabled: true},
			{ID: "w2", OrgID: "c", Events: []string{"dlr"}, Enabled: false},
			{ID: "w3", OrgID: "c", Events: []string{"other"}, Enabled: true},
		},
	})
}

func TestHierarchyLookups(t *testing.T) {
	s := unitSnapshot()
	if s.Reseller("c").ID != "r" || s.Reseller("r").ID != "r" || s.Reseller("a") != nil || s.Reseller("zz") != nil {
		t.Fatal("Reseller")
	}
	if tag, ok := s.BalanceTag("c"); !ok || tag != "r" {
		t.Fatal("tag client")
	}
	if _, ok := s.BalanceTag("a"); ok {
		t.Fatal("admin tag")
	}
	if s.Parent("c").ID != "r" || s.Parent("a") != nil {
		t.Fatal("Parent")
	}
	if len(s.Children("r")) != 2 || s.Children("r")[0].ID != "c" {
		t.Fatal("Children")
	}
	if s.Brand("c") != "ResBrand" || s.Brand("c2") != "Own" || s.Brand("r") != "ResBrand" || s.Brand("cx") != "" {
		t.Fatalf("Brand %q %q", s.Brand("c"), s.Brand("c2"))
	}
	if !s.Org("c").Effective.CanWeb {
		t.Fatal("CanWeb")
	}
}

func TestCanWebFolding(t *testing.T) {
	r := mkOrg("r", RoleReseller, "a")
	r.WebEnabled = false
	c := mkOrg("c", RoleClient, "r")
	s := NewSnapshot(Data{Orgs: []*Org{mkOrg("a", RoleSuperAdmin, ""), r, c}})
	if s.Org("c").Effective.CanWeb || s.Org("c").CanUseChannel(ChannelWeb) {
		t.Fatal("reseller web disabled must block client web")
	}
	if !s.Org("c").CanUseChannel(ChannelHTTP) || s.Org("c").CanUseChannel(ChannelSMPP) || s.Org("c").CanUseChannel("FAX") {
		t.Fatal("channels")
	}
}

func TestEffectiveTemplate(t *testing.T) {
	s := unitSnapshot()
	if s.EffectiveTemplate("rt", "c").ID != "t-c" || s.EffectiveTemplate("rt", "c2").ID != "t-default" ||
		s.EffectiveTemplate("rt", "").ID != "t-default" || s.EffectiveTemplate("none", "c") != nil {
		t.Fatal("EffectiveTemplate")
	}
	if s.EffectiveTemplate("rt2", "").PatternErr == nil {
		t.Fatal("invalid pattern not flagged")
	}
	found := false
	for _, w := range s.Warnings {
		if len(w) > 0 && contains(w, "t-bad") {
			found = true
		}
	}
	if !found {
		t.Fatalf("warning missing: %v", s.Warnings)
	}
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}

func TestSenderAllowed(t *testing.T) {
	s := unitSnapshot()
	cases := []struct {
		org, route, src  string
		allowed, restrct bool
	}{
		{"c", "rt", "MyBank", true, true},
		{"c", "rt", "MYBANK", true, true},
		{"c", "other", "mybank", true, true},
		{"c", "rt", "Promo", false, true},       // pending
		{"c", "rt", "919876543210", true, true}, // '+' ignored
		{"c", "other", "+919876543210", false, true},
		{"c2", "rt", "X", false, true},       // only rejected rows -> still restricted
		{"r", "rt", "Anything", true, false}, // no rows -> any sender
	}
	for _, c := range cases {
		a, r := s.SenderAllowed(c.org, c.route, c.src)
		if a != c.allowed || r != c.restrct {
			t.Errorf("%+v: got %v %v", c, a, r)
		}
	}
}

func TestIPAllowed(t *testing.T) {
	s := unitSnapshot()
	cases := []struct {
		org, ip, scope string
		want           bool
	}{
		{"c", "10.1.2.3", ScopeSMPP, true},
		{"c", "11.1.2.3", ScopeSMPP, false},
		{"c", "192.168.1.5", ScopeSMPP, true}, // ALL applies to SMPP
		{"c", "192.168.1.5", ScopePanel, true},
		{"c", "10.1.2.3", ScopePanel, false}, // PANEL has only the ALL row
		{"c", "2001:db8::1", ScopeAPI, true},
		{"c", "::ffff:192.168.1.5", ScopeAPI, true}, // v4-mapped unmapped
		{"c", "8.8.8.8", ScopeAPI, false},
		{"r", "8.8.8.8", ScopeAPI, true}, // no rows: open
	}
	for _, c := range cases {
		if got := s.IPAllowed(c.org, netip.MustParseAddr(c.ip), c.scope); got != c.want {
			t.Errorf("%+v: got %v", c, got)
		}
	}
	if !s.IPAllowedString("c", "10.0.0.1:5555", ScopeSMPP) || !s.IPAllowedString("c", "[2001:db8::2]:443", ScopeAPI) {
		t.Error("host:port parsing")
	}
	if s.IPAllowedString("c", "garbage", ScopeSMPP) || !s.IPAllowedString("r", "garbage", ScopeSMPP) {
		t.Error("invalid IP handling")
	}
}

func TestBlocklists(t *testing.T) {
	s := unitSnapshot()
	cases := []struct {
		org, msisdn string
		blocked     bool
		scope       string
	}{
		{"c", "999123456", true, ""},
		{"c", "919876543210", true, "r"}, // reseller row applies to client
		{"c", "447700900123", true, "c"},
		{"c", "447700900124", false, ""},
		{"c2", "447700900123", false, ""}, // other client's row
		{"c", "33123456", false, ""},      // other reseller's row
		{"cx", "33123456", true, "rx"},
		{"r", "919800000000", true, "r"},
	}
	for _, c := range cases {
		b, scope, _ := s.NumberBlocked(c.org, c.msisdn)
		if b != c.blocked || scope != c.scope {
			t.Errorf("%+v: got %v %q", c, b, scope)
		}
	}
	kw := []struct {
		org, text, want string
	}{
		{"c", "Buy BITCOIN now", "g"},
		{"c", "Visit our CASINO", "rk"},
		{"c", "WIN MONEY today", "ck"},
		{"c2", "win money", ""},
		{"c", "get a loan", ""},
		{"cx", "get a LOAN", "xk"},
		{"c", "bitcoins are fine", ""},
	}
	for _, c := range kw {
		k := s.ContentBlocked(c.org, c.text)
		got := ""
		if k != nil {
			got = k.ID
		}
		if got != c.want {
			t.Errorf("%q for %s: got %q want %q", c.text, c.org, got, c.want)
		}
	}
}

func TestMiscLookups(t *testing.T) {
	s := unitSnapshot()
	a := s.SMPPAccount("sys1")
	if a == nil || !a.AllowsBind("TRX") || a.AllowsBind("RX") || s.SMPPAccount("nope") != nil || len(s.SMPPAccounts("c")) != 1 {
		t.Fatal("smpp")
	}
	if w := s.WebhooksFor("c", "dlr"); len(w) != 1 || w[0].ID != "w1" {
		t.Fatalf("webhooks %v", w)
	}
}

func TestDiffConnectionsAndSubscriptionMerge(t *testing.T) {
	mk := func(conns ...*Connection) *Snapshot { return NewSnapshot(Data{Connections: conns}) }
	a := &Connection{ID: "a", Host: "h", Port: 1, Enabled: true}
	b := &Connection{ID: "b", Host: "h", Port: 2, Enabled: true}
	b2 := *b
	b2.Port = 3
	bNotes := *b
	bNotes.Notes = "changed notes only"
	c := &Connection{ID: "c", Host: "h", Port: 4}

	s1 := mk(a, b)
	s2 := mk(a, &b2, c)
	d := DiffConnections(s1, s2)
	if len(d.Added) != 1 || d.Added[0] != "c" || len(d.Updated) != 1 || d.Updated[0] != "b" || len(d.Removed) != 0 {
		t.Fatalf("diff %v", d)
	}
	if !DiffConnections(s1, mk(a, &bNotes)).Empty() {
		t.Fatal("notes change must not trigger a rebind")
	}
	s3 := mk(&b2)
	if d := DiffConnections(s2, s3); len(d.Removed) != 2 {
		t.Fatalf("removed %v", d)
	}

	st := New(nil, nil, nil, Options{})
	sub := st.Subscribe()
	st.publish(DiffConnections(s1, s2))
	st.publish(DiffConnections(s2, s3))
	got := <-sub.C
	// Merged s1 -> s3: a removed, b updated, c never existed in s1 or s3.
	if got.Old != s1 || got.New != s3 || len(got.Removed) != 1 || got.Removed[0] != "a" || len(got.Updated) != 1 || len(got.Added) != 0 {
		t.Fatalf("merged %v", got)
	}
	select {
	case extra := <-sub.C:
		t.Fatalf("unexpected extra diff %v", extra)
	default:
	}
	sub.Close()
	st.publish(DiffConnections(s1, s2))
	select {
	case <-sub.C:
		t.Fatal("closed subscription received")
	default:
	}
}
