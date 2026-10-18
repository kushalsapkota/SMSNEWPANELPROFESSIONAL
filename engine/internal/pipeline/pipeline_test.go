package pipeline

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"

	"smsgw/engine/internal/billing"
	"smsgw/engine/internal/cdr"
	"smsgw/engine/internal/otp"
	"smsgw/engine/internal/policy"
	"smsgw/engine/internal/ratelimit"
	"smsgw/engine/internal/store"
)

// Unit tests over a hand-built snapshot with real Redis (db 2) for the
// balance / rate-limit / queue scripts. Every test uses fresh ids.

func testRedis(t *testing.T) *redis.Client {
	t.Helper()
	u := os.Getenv("TEST_REDIS_URL")
	if u == "" {
		u = "redis://localhost:6399/2"
	}
	opt, err := redis.ParseURL(u)
	if err != nil {
		t.Fatal(err)
	}
	rdb := redis.NewClient(opt)
	if err := rdb.Ping(context.Background()).Err(); err != nil {
		t.Fatalf("redis: %v", err)
	}
	t.Cleanup(func() { rdb.Close() })
	return rdb
}

type staticSnap struct{ s *store.Snapshot }

func (s staticSnap) Current() *store.Snapshot { return s.s }

type fakeSink struct {
	mu   sync.Mutex
	ins  []cdr.Record
	upds []cdr.Update
}

func (f *fakeSink) Insert(_ context.Context, r cdr.Record) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.ins = append(f.ins, r)
	return nil
}

func (f *fakeSink) Update(_ context.Context, u cdr.Update) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.upds = append(f.upds, u)
	return nil
}

type fixture struct {
	admin, reseller, client, smppOrg, webOff, limitedOrg string
	route, otpRoute, conn                                string
	p                                                    *Pipeline
	sink                                                 *fakeSink
	rdb                                                  *redis.Client
	keys                                                 []string
}

func org(id, role, parent string) *store.Org {
	return &store.Org{ID: id, Role: role, ParentID: parent, Status: "ACTIVE", SendingEnabled: true, APIEnabled: true,
		WebEnabled: true, MaxTPS: 100, Timezone: "UTC",
		Effective: store.Effective{IsActive: true, CanSend: true, CanAPI: true, EffectiveMaxTPS: 100}}
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	f := &fixture{admin: uuid.NewString(), reseller: uuid.NewString(), client: uuid.NewString(), smppOrg: uuid.NewString(),
		webOff: uuid.NewString(), limitedOrg: uuid.NewString(),
		route: uuid.NewString(), otpRoute: uuid.NewString(), conn: uuid.NewString(), rdb: testRedis(t), sink: &fakeSink{}}
	res := org(f.reseller, store.RoleReseller, f.admin)
	res.BrandName = "ResBrand"
	cli := org(f.client, store.RoleClient, f.reseller)
	smppOrg := org(f.smppOrg, store.RoleClient, f.reseller)
	smppOrg.SMPPEnabled, smppOrg.Effective.CanSMPP = true, true
	webOff := org(f.webOff, store.RoleClient, f.reseller)
	webOff.WebEnabled = false
	lim := org(f.limitedOrg, store.RoleClient, f.reseller)
	lim.DailyLimit = 1
	conn := &store.Connection{ID: f.conn, Name: "c", Enabled: true, MaxTPS: 10, Sessions: 1}
	data := store.Data{
		Orgs:        []*store.Org{org(f.admin, store.RoleSuperAdmin, ""), res, cli, smppOrg, webOff, lim},
		Connections: []*store.Connection{conn},
		Routes: []*store.Route{
			{ID: f.route, Name: "main", Enabled: true, TemplateFallback: otp.ActionSendRaw},
			{ID: f.otpRoute, Name: "otp", Enabled: true, TemplateMode: true, TemplateFallback: otp.ActionReject},
		},
		RouteConnections: []*store.RouteConnection{
			{RouteID: f.route, ConnectionID: f.conn, Priority: 1, Weight: 1, Enabled: true},
			{RouteID: f.otpRoute, ConnectionID: f.conn, Priority: 1, Weight: 1, Enabled: true},
		},
		Templates: []*store.Template{{ID: uuid.NewString(), RouteID: f.otpRoute,
			Template: otp.Template{Patterns: otp.DefaultPatterns, MinLen: 4, MaxLen: 8, Body: "{brand} code {otp} from {sender}"}}},
		BlockedNumbers:  []*store.BlockedNumber{{OrgID: f.reseller, Prefix: "4479"}},
		BlockedKeywords: []*store.BlockedKeyword{{OrgID: "", Pattern: `\bcasino\b`}},
		SMPPAccounts:    []*store.SMPPAccount{{ID: uuid.NewString(), OrgID: f.smppOrg, SystemID: "sys" + f.smppOrg[:8], Enabled: true, MaxTPS: 50}},
		SenderIDs:       []*store.SenderID{{OrgID: f.webOff, Sender: "OKSENDER", Status: "APPROVED"}},
	}
	for _, o := range []string{f.reseller, f.client, f.smppOrg, f.webOff, f.limitedOrg} {
		data.Assignments = append(data.Assignments,
			&store.Assignment{ID: uuid.NewString(), OrgID: o, RouteID: f.route, Prefix: "", RateMicros: 100, Priority: 1, Enabled: true},
			&store.Assignment{ID: uuid.NewString(), OrgID: o, RouteID: f.otpRoute, Prefix: "91", RateMicros: 300, Priority: 1, Enabled: true})
	}
	// Reseller pays less than its clients.
	for _, a := range data.Assignments {
		if a.OrgID == f.reseller {
			a.RateMicros /= 2
		}
	}
	snap := store.NewSnapshot(data)
	// Load balances directly (what load.lua does after hydration).
	ctx := context.Background()
	for _, o := range []string{f.reseller, f.client, f.smppOrg, f.webOff, f.limitedOrg} {
		k := billing.BalanceKey(f.reseller, o)
		f.keys = append(f.keys, k)
		f.rdb.HSet(ctx, k, "bal", 10_000, "limit", 0)
	}
	f.p = New(Deps{Store: staticSnap{snap}, Biller: billing.New(f.rdb, nil, billing.Options{DirtyKey: "test:pipeline:dirty:" + f.reseller}),
		Limiter: ratelimit.New(f.rdb), CDR: f.sink, Redis: f.rdb})
	t.Cleanup(func() {
		keys := append(f.keys, DispatchStream(f.route), DispatchStream(f.otpRoute), "test:pipeline:dirty:"+f.reseller)
		f.rdb.Del(context.Background(), keys...)
	})
	return f
}

func (f *fixture) bal(t *testing.T, o string) int64 {
	t.Helper()
	v, err := f.rdb.HGet(context.Background(), billing.BalanceKey(f.reseller, o), "bal").Int64()
	if err != nil {
		t.Fatal(err)
	}
	return v
}

func TestSubmitHappyPath(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	res, err := f.p.Submit(ctx, Request{OrgID: f.client, Channel: store.ChannelHTTP, Source: "MyBank", Destination: "+44 7700-900123",
		Text: strings.Repeat("a", 170), ClientRef: "r1"})
	if err != nil {
		t.Fatal(err)
	}
	if res.Parts != 2 || res.Encoding != "GSM7" || res.CostMicros != 200 || res.RouteID != f.route || res.Status != "ACCEPTED" {
		t.Fatalf("result %+v", res)
	}
	if f.bal(t, f.client) != 10_000-200 || f.bal(t, f.reseller) != 10_000-100 {
		t.Fatalf("balances %d %d", f.bal(t, f.client), f.bal(t, f.reseller))
	}
	if len(f.sink.ins) != 1 {
		t.Fatal("no CDR")
	}
	r := f.sink.ins[0]
	if r.ID != res.MessageID || r.ResellerID != f.reseller || r.DestinationAddr != "447700900123" || r.SourceTON != 5 || r.DestTON != 1 ||
		*r.ClientCostMicros != 200 || *r.ResellerCostMicros != 100 || *r.ClientRateMicros != 100 || r.OTPExtracted != nil ||
		r.Status != "ACCEPTED" || r.CountryISO != "JE" || r.ClientMsgRef != "r1" || !r.CreatedAt.Equal(res.CreatedAt) {
		t.Fatalf("cdr %+v", r)
	}
	if u, err := uuid.Parse(res.MessageID); err != nil || u.Version() != 7 {
		t.Fatalf("message id %s not UUIDv7", res.MessageID)
	}
	// Queue entry and message state.
	msgs, err := f.rdb.XRange(ctx, DispatchStream(f.route), "-", "+").Result()
	if err != nil || len(msgs) != 1 {
		t.Fatalf("stream %v %v", msgs, err)
	}
	job, err := DecodeJob(msgs[0].Values)
	if err != nil {
		t.Fatal(err)
	}
	if job.ID != res.MessageID || job.Parts != 2 || job.Tag != f.reseller || len(job.Legs) != 2 || job.Legs[0].Amount != 200 ||
		job.Legs[1].OrgID != f.reseller || job.Legs[1].Amount != 100 || job.CreatedMS != res.CreatedAt.UnixMilli() {
		b, _ := json.Marshal(job)
		t.Fatalf("job %s", b)
	}
	h, _ := f.rdb.HGetAll(ctx, MsgKey(res.MessageID)).Result()
	f.keys = append(f.keys, MsgKey(res.MessageID), billing.TxnKey(f.reseller, res.MessageID))
	if h[FOrgID] != f.client || h[FParts] != "2" || h[FDelivered] != "0" || h[FChannel] != "HTTP" || h[FClientRef] != "r1" ||
		h[FRegDelivery] != "1" || len(h[FText20]) != 20 {
		t.Fatalf("msg state %v", h)
	}
	if ttl := f.rdb.TTL(ctx, MsgKey(res.MessageID)).Val(); ttl < 71*time.Hour {
		t.Fatalf("ttl %v", ttl)
	}
}

func TestOTPTemplate(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	res, err := f.p.Submit(ctx, Request{OrgID: f.client, Channel: store.ChannelWeb, Source: "MyBank", Destination: "919876543210", Text: "Your OTP is 4821"})
	if err != nil {
		t.Fatal(err)
	}
	if res.SentText != "ResBrand code 4821 from MyBank" || res.CostMicros != 300 || res.RouteID != f.otpRoute {
		t.Fatalf("%+v", res)
	}
	r := f.sink.ins[0]
	if r.OTPExtracted == nil || !*r.OTPExtracted || r.TemplateID == "" || r.OrigText != "Your OTP is 4821" {
		t.Fatalf("cdr %+v", r)
	}
	_, err = f.p.Submit(ctx, Request{OrgID: f.client, Channel: store.ChannelWeb, Source: "MyBank", Destination: "919876543210", Text: "hello"})
	if policy.CodeOf(err) != policy.CodeOTPNotFound {
		t.Fatalf("got %v", err)
	}
}

func TestRejections(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	long := strings.Repeat("x", 153*10+1)
	cases := []struct {
		name string
		req  Request
		code policy.Code
	}{
		{"bad org id", Request{OrgID: "nope", Channel: "HTTP", Source: "A1", Destination: "447700900123", Text: "x"}, policy.CodeInvalidRequest},
		{"unknown org", Request{OrgID: uuid.NewString(), Channel: "HTTP", Source: "A1", Destination: "447700900123", Text: "x"}, policy.CodeUnauthorized},
		{"no smpp", Request{OrgID: f.client, Channel: "SMPP", SMPPSystemID: "x", Source: "A1", Destination: "447700900123", Text: "x"}, policy.CodeChannelDisabled},
		{"smpp unknown account", Request{OrgID: f.smppOrg, Channel: "SMPP", SMPPSystemID: "nope", Source: "A1", Destination: "447700900123", Text: "x"}, policy.CodeUnauthorized},
		{"web off", Request{OrgID: f.webOff, Channel: "WEB", Source: "OKSENDER", Destination: "447700900123", Text: "x"}, policy.CodeChannelDisabled},
		{"bad dest", Request{OrgID: f.client, Channel: "HTTP", Source: "A1", Destination: "12ab", Text: "x"}, policy.CodeInvalidDestination},
		{"blocked dest", Request{OrgID: f.client, Channel: "HTTP", Source: "A1", Destination: "447912345678", Text: "x"}, policy.CodeDestinationBlocked},
		{"blocked word", Request{OrgID: f.client, Channel: "HTTP", Source: "A1", Destination: "447700900123", Text: "Best CASINO deals"}, policy.CodeContentBlocked},
		{"sender", Request{OrgID: f.webOff, Channel: "HTTP", Source: "OTHER", Destination: "447700900123", Text: "x"}, policy.CodeSenderNotAllowed},
		{"too long", Request{OrgID: f.client, Channel: "HTTP", Source: "A1", Destination: "447700900123", Text: long}, policy.CodeMessageTooLong},
		{"forced route not assigned", Request{OrgID: f.client, Channel: "HTTP", Source: "A1", Destination: "447700900123", Text: "x", RouteID: uuid.NewString()}, policy.CodeRouteNotFound},
	}
	for _, c := range cases {
		if _, err := f.p.Submit(ctx, c.req); policy.CodeOf(err) != c.code {
			t.Errorf("%s: got %v, want %s", c.name, err, c.code)
		}
	}
	if len(f.sink.ins) != 0 || f.bal(t, f.client) != 10_000 {
		t.Fatalf("rejections must not charge or record (%d cdrs, bal %d)", len(f.sink.ins), f.bal(t, f.client))
	}
}

func TestInsufficientFundsReleasesDailyCounter(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	f.rdb.HSet(ctx, billing.BalanceKey(f.reseller, f.limitedOrg), "bal", 50)
	req := Request{OrgID: f.limitedOrg, Channel: "HTTP", Source: "A1", Destination: "447700900123", Text: "x"}
	if _, err := f.p.Submit(ctx, req); policy.CodeOf(err) != policy.CodeInsufficientFunds {
		t.Fatalf("got %v", err)
	}
	// The daily limit is 1: the failed attempt must not have used it.
	f.rdb.HSet(ctx, billing.BalanceKey(f.reseller, f.limitedOrg), "bal", 10_000)
	res, err := f.p.Submit(ctx, req)
	if err != nil {
		t.Fatalf("daily counter not released: %v", err)
	}
	f.keys = append(f.keys, MsgKey(res.MessageID), billing.TxnKey(f.reseller, res.MessageID))
	if _, err := f.p.Submit(ctx, req); policy.CodeOf(err) != policy.CodeDailyLimit {
		t.Fatalf("got %v", err)
	}
	l := ratelimit.New(f.rdb)
	_, d, m := l.Keys(f.limitedOrg, "UTC", time.Now())
	f.keys = append(f.keys, d, m)
}

func TestSuperAdminTesterIsNotBilledAndResellerSingleLeg(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	res, err := f.p.Submit(ctx, Request{OrgID: f.admin, Channel: "HTTP", Source: "A1", Destination: "447700900123", Text: "t", RouteID: f.route, Test: true})
	if err != nil {
		t.Fatal(err)
	}
	if res.CostMicros != 0 || f.sink.ins[0].ClientCostMicros != nil || f.sink.ins[0].ResellerID != "" {
		t.Fatalf("admin test %+v %+v", res, f.sink.ins[0])
	}
	if _, err := f.p.Submit(ctx, Request{OrgID: f.admin, Channel: "HTTP", Source: "A1", Destination: "447700900123", Text: "t"}); policy.CodeOf(err) != policy.CodeRouteNotFound {
		t.Fatalf("admin without route: %v", err)
	}
	res2, err := f.p.Submit(ctx, Request{OrgID: f.reseller, Channel: "HTTP", Source: "A1", Destination: "447700900123", Text: "t", Test: true})
	if err != nil {
		t.Fatal(err)
	}
	if res2.CostMicros != 50 || f.bal(t, f.reseller) != 10_000-50 {
		t.Fatalf("reseller: %+v bal %d", res2, f.bal(t, f.reseller))
	}
	r := f.sink.ins[1]
	if *r.ClientCostMicros != 50 || *r.ResellerCostMicros != 50 || r.ResellerID != f.reseller {
		t.Fatalf("reseller cdr %+v", r)
	}
	f.keys = append(f.keys, MsgKey(res.MessageID), MsgKey(res2.MessageID), billing.TxnKey(f.reseller, res2.MessageID))
}

func TestSMPPSubmitUsesGivenIDAndRegisteredDelivery(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	id := NewMessageID()
	sys := "sys" + f.smppOrg[:8]
	res, err := f.p.Submit(ctx, Request{OrgID: f.smppOrg, Channel: "SMPP", SMPPSystemID: sys, MessageID: id, RegisteredDelivery: 2,
		Source: "12345", Destination: "447700900123", Text: "hi"})
	if err != nil {
		t.Fatal(err)
	}
	f.keys = append(f.keys, MsgKey(id), billing.TxnKey(f.reseller, id))
	if res.MessageID != id || f.sink.ins[0].ClientMsgRef != id || f.sink.ins[0].SourceTON != 3 {
		t.Fatalf("%+v %+v", res, f.sink.ins[0])
	}
	h, _ := f.rdb.HGetAll(ctx, MsgKey(id)).Result()
	if h[FSMPPSystemID] != sys || h[FRegDelivery] != "2" || h[FChannel] != "SMPP" {
		t.Fatalf("state %v", h)
	}
}

func TestPreview(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	fb := "SEND_DEFAULT_TEMPLATE"
	def := "{brand}: no code"
	res, err := f.p.Preview(ctx, PreviewRequest{Text: "nothing", OrgID: f.client, Template: &InlineTemplate{TemplateBody: "{otp}", DefaultBody: &def, FallbackAction: &fb}})
	if err != nil {
		t.Fatal(err)
	}
	if res.Action != "SEND_DEFAULT_TEMPLATE" || *res.Output != "ResBrand: no code" || res.OTP != nil || res.TemplateID != nil {
		t.Fatalf("%+v", res)
	}
	if _, err := f.p.Preview(ctx, PreviewRequest{Text: "x", Template: &InlineTemplate{TemplateBody: "{otp}", ExtractPatterns: []string{"("}}}); policy.CodeOf(err) != policy.CodeInvalidRequest {
		t.Fatalf("bad pattern: %v", err)
	}
	if _, err := f.p.Preview(ctx, PreviewRequest{Text: "x"}); policy.CodeOf(err) != policy.CodeInvalidRequest {
		t.Fatalf("no template: %v", err)
	}
	res, err = f.p.Preview(ctx, PreviewRequest{Text: "Код 5521 ваш", RouteID: f.otpRoute})
	if err != nil {
		t.Fatal(err)
	}
	if res.Action != "TEMPLATED" || *res.OTP != "5521" || res.Encoding != "GSM7" || res.TemplateID == nil {
		t.Fatalf("%+v", res)
	}
}

func TestDLRMapValue(t *testing.T) {
	v := DLRMapValue("m", 3, 1700000000123)
	id, part, ms, err := ParseDLRMapValue(v)
	if err != nil || id != "m" || part != 3 || ms != 1700000000123 {
		t.Fatalf("%s %d %d %v", id, part, ms, err)
	}
	for _, bad := range []string{"", "a|b", "a|x|1", "|1|2", "a|1|z"} {
		if _, _, _, err := ParseDLRMapValue(bad); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
}
