package app

import (
	"context"
	"io"
	"log/slog"
	"net"
	"net/netip"
	"testing"
	"time"

	"smsgw/engine/internal/crypto"
	"smsgw/engine/internal/smpp/pdu"
	"smsgw/engine/internal/smpp/server"
	"smsgw/engine/internal/store"
)

var quiet = slog.New(slog.NewTextHandler(io.Discard, nil))

type snapSrc struct{ s *store.Snapshot }

func (s snapSrc) Current() *store.Snapshot { return s.s }

func client(id, parent string) *store.Org {
	return &store.Org{ID: id, Role: store.RoleClient, ParentID: parent, Status: "ACTIVE", SendingEnabled: true, SMPPEnabled: true,
		Effective: store.Effective{IsActive: true, CanSend: true, CanSMPP: true, EffectiveMaxTPS: 10}}
}

func newAuth(t *testing.T, rules ...*store.IPRule) *authenticator {
	t.Helper()
	hash, err := crypto.HashPassword("secret")
	if err != nil {
		t.Fatal(err)
	}
	snap := store.NewSnapshot(store.Data{
		Orgs: []*store.Org{{ID: "res", Role: store.RoleReseller, ParentID: "adm", Status: "ACTIVE", SendingEnabled: true, SMPPEnabled: true,
			Effective: store.Effective{IsActive: true, CanSend: true, CanSMPP: true}}, client("cli", "res")},
		SMPPAccounts: []*store.SMPPAccount{{ID: "acct", OrgID: "cli", SystemID: "acme", PasswordHash: hash, AllowedBindTypes: []string{"TRX"}, MaxBinds: 2, Enabled: true}},
		IPRules:      rules,
	})
	return &authenticator{store: snapSrc{snap}, cache: crypto.NewBindCache(time.Minute, 0), guard: newBindGuard(time.Minute, 5, 8),
		log: quiet, sem: make(chan struct{}, 1)}
}

func bind(a *authenticator, ip, pw string) pdu.CommandStatus {
	_, st := a.Authenticate(context.Background(), &server.BindRequest{BindType: pdu.BindTransceiver, SystemID: "acme", Password: pw,
		RemoteAddr: &net.TCPAddr{IP: net.ParseIP(ip), Port: 1234}})
	return st
}

// Callers outside the account's whitelist are refused before the password
// is checked: they learn nothing about it and cost no argon2.
func TestBindWhitelistCheckedBeforePassword(t *testing.T) {
	a := newAuth(t, &store.IPRule{OrgID: "cli", Prefix: netip.MustParsePrefix("10.0.0.0/8"), Scope: store.ScopeSMPP})
	a.sem = make(chan struct{}) // any argon2 attempt would block until the ctx deadline
	start := time.Now()
	if st := bind(a, "192.0.2.1", "wrong"); st != pdu.ESME_RBINDFAIL {
		t.Fatalf("outside whitelist, wrong password: %v", st)
	}
	if st := bind(a, "192.0.2.1", "secret"); st != pdu.ESME_RBINDFAIL {
		t.Fatalf("outside whitelist, right password: %v", st)
	}
	if time.Since(start) > time.Second {
		t.Fatal("password was verified for a non-whitelisted caller")
	}
}

// Repeated failures lock out the source IP and the system_id without
// running argon2; credentials that verified recently still bind.
func TestBindGuardLimitsGuessing(t *testing.T) {
	a := newAuth(t)
	if st := bind(a, "10.0.0.1", "secret"); st != pdu.ESME_ROK { // caches the good credentials
		t.Fatal(st)
	}
	for i := 0; i < 5; i++ {
		if st := bind(a, "192.0.2.7", "guess"); st != pdu.ESME_RINVPASWD {
			t.Fatalf("guess %d: %v", i, st)
		}
	}
	if st := bind(a, "192.0.2.7", "guess"); st != pdu.ESME_RBINDFAIL {
		t.Fatalf("IP not locked out: %v", st)
	}
	// The owner's correct password from another IP is still fine (cached).
	if st := bind(a, "10.0.0.1", "secret"); st != pdu.ESME_ROK {
		t.Fatalf("owner locked out: %v", st)
	}
	// Spread over many IPs, the system_id budget (8) runs out too.
	for i := 0; i < 3; i++ {
		bind(a, "198.51.100."+string(rune('1'+i)), "guess")
	}
	if st := bind(a, "198.51.100.9", "guess"); st != pdu.ESME_RBINDFAIL {
		t.Fatalf("system_id not locked out: %v", st)
	}
	// Unknown system_ids count against the IP as well.
	g := newBindGuard(time.Minute, 2, 100)
	a.guard = g
	for i := 0; i < 2; i++ {
		_, st := a.Authenticate(context.Background(), &server.BindRequest{SystemID: "nobody", RemoteAddr: &net.TCPAddr{IP: net.ParseIP("203.0.113.5")}})
		if st != pdu.ESME_RINVSYSID {
			t.Fatal(st)
		}
	}
	if !g.blocked("203.0.113.5", "") {
		t.Fatal("system_id enumeration not limited per IP")
	}
}

func TestBindGuardWindow(t *testing.T) {
	now := time.Unix(1000, 0)
	g := newBindGuard(time.Minute, 2, 3)
	g.now = func() time.Time { return now }
	g.fail("ip", "sys")
	g.fail("ip", "sys")
	if !g.blocked("ip", "") || g.blocked("other", "sys") {
		t.Fatal("ip budget")
	}
	g.fail("ip2", "sys")
	if !g.blocked("other", "sys") {
		t.Fatal("system_id budget")
	}
	now = now.Add(61 * time.Second)
	if g.blocked("ip", "sys") {
		t.Fatal("window did not expire")
	}
}

func TestLimitUpdates(t *testing.T) {
	mk := func(mode string, limit int64) *store.Snapshot {
		res := &store.Org{ID: "res", Role: store.RoleReseller, ParentID: "adm", Account: &store.Account{BillingMode: "PREPAID"}}
		cli := client("cli", "res")
		cli.Account = &store.Account{BillingMode: mode, CreditLimitMicros: limit}
		return store.NewSnapshot(store.Data{Orgs: []*store.Org{{ID: "adm", Role: store.RoleSuperAdmin}, res, cli}})
	}
	post := mk("POSTPAID", 50_000_000)
	if ups := limitUpdates(nil, post); len(ups) != 2 {
		t.Fatalf("startup must push every billable org: %+v", ups)
	}
	if ups := limitUpdates(post, mk("POSTPAID", 50_000_000)); len(ups) != 0 {
		t.Fatalf("no change: %+v", ups)
	}
	ups := limitUpdates(post, mk("PREPAID", 0))
	if len(ups) != 1 || ups[0].OrgID != "cli" || ups[0].Tag != "res" || ups[0].Limit != 0 {
		t.Fatalf("postpaid -> prepaid: %+v", ups)
	}
	if ups := limitUpdates(mk("PREPAID", 0), mk("POSTPAID", 1_000_000)); len(ups) != 1 || ups[0].Limit != 1_000_000 {
		t.Fatalf("raise: %+v", ups)
	}
}
