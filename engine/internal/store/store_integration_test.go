package store

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"

	"smsgw/engine/internal/crypto"
	"smsgw/engine/internal/otp"
)

// Integration tests: Postgres sms_core (db/reset-db.sh sms_core) as the
// engine login, Redis db 1 on :6399. Each test uses fresh UUIDs and its own
// pubsub channel (pubsub is not scoped by Redis DB index).

func testEnv(t *testing.T) (*pgxpool.Pool, *redis.Client) {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		dsn = "postgres://sms_engine_login:sms_engine_dev@localhost:5432/sms_core"
	}
	ru := os.Getenv("TEST_REDIS_URL")
	if ru == "" {
		ru = "redis://localhost:6399/1"
	}
	pool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Fatal(err)
	}
	if err := pool.Ping(context.Background()); err != nil {
		t.Fatalf("postgres (run db/reset-db.sh sms_core): %v", err)
	}
	opt, err := redis.ParseURL(ru)
	if err != nil {
		t.Fatal(err)
	}
	rdb := redis.NewClient(opt)
	if err := rdb.Ping(context.Background()).Err(); err != nil {
		t.Fatalf("redis: %v", err)
	}
	t.Cleanup(func() { pool.Close(); _ = rdb.Close() })
	return pool, rdb
}

func randHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)[:n]
}

func randDigits(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	for i := range b {
		b[i] = '0' + b[i]%10
	}
	return string(b)
}

type seeded struct {
	admin, reseller, client, suspended string
	conn, badConn, route               string
	tplDefault, tplClient              string
	systemID, smppPassword             string
	globalBlock                        string
}

func seed(t *testing.T, pool *pgxpool.Pool, c *crypto.Cipher) seeded {
	t.Helper()
	ctx := context.Background()
	s := seeded{admin: uuid.NewString(), reseller: uuid.NewString(), client: uuid.NewString(), suspended: uuid.NewString(),
		conn: uuid.NewString(), badConn: uuid.NewString(), route: uuid.NewString(),
		tplDefault: uuid.NewString(), tplClient: uuid.NewString(),
		systemID: "s" + randHex(10), smppPassword: "pw12", globalBlock: "999" + randDigits(9)}
	pwEnc, _ := c.EncryptString("upw123")
	whEnc, _ := c.EncryptString("whsec_abc")
	hash, _ := crypto.HashPassword(s.smppPassword)
	sfx := randHex(8)
	stmts := []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO organizations (id, role, name) VALUES ($1, 'SUPER_ADMIN', 'adm-'||$2)`, []any{s.admin, sfx}},
		{`INSERT INTO organizations (id, role, parent_id, name, brand_name, max_tps, web_enabled, smpp_enabled) VALUES ($1, 'RESELLER', $2, 'res-'||$3, 'ResBrand', 50, false, true)`, []any{s.reseller, s.admin, sfx}},
		{`INSERT INTO organizations (id, role, parent_id, name, max_tps, daily_limit, timezone, smpp_enabled) VALUES ($1, 'CLIENT', $2, 'cli-'||$3, 100, 1000, 'Asia/Kolkata', true)`, []any{s.client, s.reseller, sfx}},
		{`INSERT INTO organizations (id, role, parent_id, name, status, suspended_reason) VALUES ($1, 'CLIENT', $2, 'sus-'||$3, 'SUSPENDED', 'unpaid')`, []any{s.suspended, s.reseller, sfx}},
		{`INSERT INTO accounts_balance (org_id, billing_mode, credit_limit_micros, balance_micros) VALUES ($1, 'POSTPAID', 1000, 5)`, []any{s.reseller}},
		{`INSERT INTO accounts_balance (org_id, balance_micros, low_balance_alert_micros, currency) VALUES ($1, 77, 10, 'INR')`, []any{s.client}},
		{`INSERT INTO upstream_connections (id, name, host, port, system_id, password_enc, max_tps, sessions, submit_timeout_ms, multipart_mode)
		  VALUES ($1, 'up-'||$2, 'smsc.local', 2776, 'u'||$2, $3, 200, 2, 5000, 'SAR')`, []any{s.conn, sfx, pwEnc}},
		{`INSERT INTO upstream_connections (id, name, host, port, system_id, password_enc, max_tps) VALUES ($1, 'bad-'||$2, 'smsc.local', 2777, 'b'||$2, 'v1:garbage', 10)`, []any{s.badConn, sfx}},
		{`INSERT INTO upstream_rates (connection_id, prefix, cost_micros, effective_from) VALUES ($1, '91', 9, now() - interval '2 days')`, []any{s.conn}},
		{`INSERT INTO upstream_rates (connection_id, prefix, cost_micros, effective_from) VALUES ($1, '91', 5, now() - interval '1 hour')`, []any{s.conn}},
		{`INSERT INTO upstream_rates (connection_id, prefix, cost_micros, effective_from) VALUES ($1, '91', 1, now() + interval '1 day')`, []any{s.conn}},
		{`INSERT INTO upstream_rates (connection_id, prefix, cost_micros, effective_from) VALUES ($1, '', 20, now() - interval '1 hour')`, []any{s.conn}},
		{`INSERT INTO routes (id, name, template_mode, template_fallback) VALUES ($1, 'route-'||$2, true, 'REJECT')`, []any{s.route, sfx}},
		{`INSERT INTO route_connections (route_id, connection_id, priority, weight) VALUES ($1, $2, 1, 100)`, []any{s.route, s.conn}},
		{`INSERT INTO route_connections (route_id, connection_id, priority, weight) VALUES ($1, $2, 2, 50)`, []any{s.route, s.badConn}},
		{`INSERT INTO org_route_assignments (org_id, route_id, prefix, rate_micros) VALUES ($1, $2, '', 50)`, []any{s.reseller, s.route}},
		{`INSERT INTO org_route_assignments (org_id, route_id, prefix, rate_micros, priority) VALUES ($1, $2, '91', 100, 3)`, []any{s.client, s.route}},
		{`INSERT INTO route_templates (id, route_id, name, template_body) VALUES ($1, $2, 'default', '{brand}: {otp}')`, []any{s.tplDefault, s.route}},
		{`INSERT INTO route_templates (id, route_id, org_id, name, template_body, default_body, fallback_action, brand, otp_min_len, otp_max_len)
		  VALUES ($1, $2, $3, 'client', 'C {otp}', 'no code', 'SEND_DEFAULT_TEMPLATE', 'TplBrand', 6, 6)`, []any{s.tplClient, s.route, s.client}},
		{`INSERT INTO sender_ids (org_id, sender, status) VALUES ($1, 'MYBANK', 'APPROVED')`, []any{s.client}},
		{`INSERT INTO sender_ids (org_id, route_id, sender, status) VALUES ($1, $2, 'OTHER', 'PENDING')`, []any{s.client, s.route}},
		{`INSERT INTO smpp_accounts (org_id, system_id, password_hash, max_tps, allowed_bind_types) VALUES ($1, $2, $3, 5, ARRAY['TRX']::bind_type[])`, []any{s.client, s.systemID, hash}},
		{`INSERT INTO ip_whitelists (org_id, cidr, scope) VALUES ($1, '10.0.0.0/8', 'SMPP')`, []any{s.client}},
		{`INSERT INTO ip_whitelists (org_id, cidr, scope) VALUES ($1, '192.168.1.5', 'ALL')`, []any{s.client}},
		{`INSERT INTO webhooks (org_id, url, secret_enc, events) VALUES ($1, 'https://example.com/h', $2, ARRAY['dlr'])`, []any{s.client, whEnc}},
		{`INSERT INTO blocked_numbers (org_id, prefix) VALUES (NULL, $1)`, []any{s.globalBlock}},
		{`INSERT INTO blocked_numbers (org_id, prefix) VALUES ($1, '9198')`, []any{s.reseller}},
		{`INSERT INTO blocked_keywords (org_id, pattern) VALUES ($1, 'casino')`, []any{s.reseller}},
		{`INSERT INTO blocked_keywords (org_id, pattern) VALUES ($1, '(free|win) money')`, []any{s.client}},
		{`INSERT INTO blocked_keywords (org_id, pattern) VALUES ($1, '(unclosed')`, []any{s.client}},
	}
	for _, st := range stmts {
		if _, err := pool.Exec(ctx, st.sql, st.args...); err != nil {
			t.Fatalf("seed %s: %v", st.sql, err)
		}
	}
	return s
}

func testCipher(t *testing.T) *crypto.Cipher {
	key := make([]byte, 32)
	_, _ = rand.Read(key)
	c, err := crypto.NewCipher(key)
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func TestLoadFromPostgres(t *testing.T) {
	pool, _ := testEnv(t)
	c := testCipher(t)
	s := seed(t, pool, c)
	st := New(pool, nil, c, Options{})
	if _, err := st.MustCurrent(); err == nil {
		t.Fatal("snapshot before load")
	}
	if err := st.Load(context.Background()); err != nil {
		t.Fatal(err)
	}
	snap := st.Current()
	if snap.Version != 1 {
		t.Fatalf("version %d", snap.Version)
	}

	cli := snap.Org(s.client)
	if cli == nil || cli.Role != RoleClient || cli.ParentID != s.reseller || cli.Timezone != "Asia/Kolkata" || cli.DailyLimit != 1000 {
		t.Fatalf("client %+v", cli)
	}
	// effective_max_tps = least(100, reseller 50); reseller web disabled -> client can't use WEB.
	if cli.Effective.EffectiveMaxTPS != 50 || !cli.Effective.CanSend || !cli.Effective.CanAPI || !cli.Effective.CanSMPP || cli.Effective.CanWeb {
		t.Fatalf("effective %+v", cli.Effective)
	}
	if cli.Account == nil || cli.Account.BalanceMicros != 77 || cli.Account.Currency != "INR" || *cli.Account.LowBalanceAlertMicros != 10 || cli.Account.OverdraftLimit() != 0 {
		t.Fatalf("account %+v", cli.Account)
	}
	if r := snap.Org(s.reseller); r.Account.OverdraftLimit() != 1000 || r.BrandName != "ResBrand" {
		t.Fatalf("reseller %+v", r.Account)
	}
	if sus := snap.Org(s.suspended); sus.Effective.IsActive || sus.Effective.CanSend || sus.SuspendedReason != "unpaid" || sus.Account != nil {
		t.Fatalf("suspended %+v", sus)
	}
	if snap.Org(s.admin).Account != nil {
		t.Fatal("admin account")
	}

	conn := snap.Connection(s.conn)
	if conn == nil || conn.Password != "upw123" || conn.PasswordErr != nil || conn.Sessions != 2 ||
		conn.SubmitTimeout != 5*time.Second || conn.EnquireLinkInterval != 30*time.Second || conn.MultipartMode != "SAR" || conn.BindType != "TRX" {
		t.Fatalf("conn %+v", conn)
	}
	if len(conn.Rates) != 2 || conn.Rates[0].Prefix != "91" || conn.Rates[0].CostMicros != 5 || conn.Rates[1].Prefix != "" {
		t.Fatalf("rates: latest effective per prefix expected, got %+v %+v", conn.Rates[0], conn.Rates)
	}
	bad := snap.Connection(s.badConn)
	if bad.PasswordErr == nil || bad.Password != "" {
		t.Fatal("bad password not flagged")
	}
	route := snap.Route(s.route)
	if route == nil || !route.TemplateMode || route.TemplateFallback != otp.ActionReject || len(route.Connections) != 2 ||
		route.Connections[0].ConnectionID != s.conn || route.Connections[0].Connection != conn || !route.HasUsableConnection() ||
		route.Connections[1].Usable() {
		t.Fatalf("route %+v", route)
	}
	if as := snap.Assignments(s.client); len(as) != 1 || as[0].Prefix != "91" || as[0].RateMicros != 100 || as[0].Priority != 3 {
		t.Fatalf("assignments %+v", as)
	}
	tc := snap.EffectiveTemplate(s.route, s.client)
	if tc == nil || tc.ID != s.tplClient || tc.Fallback != otp.ActionSendDefaultTemplate || tc.Brand != "TplBrand" ||
		tc.MinLen != 6 || *tc.DefaultBody != "no code" || tc.PatternErr != nil {
		t.Fatalf("client template %+v", tc)
	}
	td := snap.EffectiveTemplate(s.route, s.suspended)
	if td == nil || td.ID != s.tplDefault || td.Fallback != "" || td.DefaultBody != nil || len(td.Patterns) != len(otp.DefaultPatterns) {
		t.Fatalf("default template %+v", td)
	}
	// DB default patterns (migration 005) == otp.DefaultPatterns.
	for i, p := range otp.DefaultPatterns {
		if td.Patterns[i] != p {
			t.Fatalf("DB default pattern %d = %q, want %q", i, td.Patterns[i], p)
		}
	}
	res, err := otp.Resolve(&td.Template, route.TemplateFallback, "Pay Rs 2500. OTP 772211", otp.Vars{Brand: snap.Brand(s.client)})
	if err != nil || res.Output != "ResBrand: 772211" {
		t.Fatalf("resolve %+v %v", res, err)
	}
	if ok, restricted := snap.SenderAllowed(s.client, s.route, "mybank"); !ok || !restricted {
		t.Fatal("sender")
	}
	if ok, _ := snap.SenderAllowed(s.client, s.route, "OTHER"); ok {
		t.Fatal("pending sender allowed")
	}
	acct := snap.SMPPAccount(s.systemID)
	if acct == nil || acct.OrgID != s.client || acct.MaxTPS != 5 || !acct.AllowsBind("TRX") || acct.AllowsBind("TX") || !acct.Enabled {
		t.Fatalf("smpp %+v", acct)
	}
	if ok, _ := crypto.VerifyPassword(s.smppPassword, acct.PasswordHash); !ok {
		t.Fatal("smpp hash")
	}
	if !snap.IPAllowedString(s.client, "10.9.9.9", ScopeSMPP) || snap.IPAllowedString(s.client, "11.0.0.1", ScopeSMPP) ||
		!snap.IPAllowedString(s.client, "192.168.1.5", ScopeAPI) || snap.IPAllowedString(s.client, "10.9.9.9", ScopeAPI) {
		t.Fatal("ip rules")
	}
	if wh := snap.WebhooksFor(s.client, "dlr"); len(wh) != 1 || wh[0].Secret != "whsec_abc" || wh[0].MaxRetries != 8 {
		t.Fatalf("webhooks %+v", wh)
	}
	if b, scope, _ := snap.NumberBlocked(s.client, s.globalBlock+"1"); !b || scope != "" {
		t.Fatal("global block")
	}
	if b, scope, _ := snap.NumberBlocked(s.client, "919812345678"); !b || scope != s.reseller {
		t.Fatal("reseller block")
	}
	if k := snap.ContentBlocked(s.client, "Play CASINO"); k == nil {
		t.Fatal("reseller keyword")
	}
	if k := snap.ContentBlocked(s.client, "Free Money!"); k == nil {
		t.Fatal("client keyword")
	}
	var sawKw, sawConn bool
	for _, w := range snap.Warnings {
		sawKw = sawKw || strings.Contains(w, "(unclosed")
		sawConn = sawConn || strings.Contains(w, s.badConn)
	}
	if !sawKw || !sawConn {
		t.Fatalf("warnings missing: %v", snap.Warnings)
	}
}

func waitDiff(t *testing.T, sub *Subscription, pred func(ConnDiff) bool) ConnDiff {
	t.Helper()
	deadline := time.After(5 * time.Second)
	for {
		select {
		case d := <-sub.C:
			if pred(d) {
				return d
			}
		case <-deadline:
			t.Fatal("timed out waiting for connection diff")
			return ConnDiff{}
		}
	}
}

func has(ids []string, id string) bool {
	for _, x := range ids {
		if x == id {
			return true
		}
	}
	return false
}

func TestInvalidateReloadAndDiff(t *testing.T) {
	pool, rdb := testEnv(t)
	c := testCipher(t)
	s := seed(t, pool, c)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	channel := "cfg:invalidate:test:" + uuid.NewString()
	st := New(pool, rdb, c, Options{ReloadInterval: time.Hour, Debounce: 100 * time.Millisecond, MaxDebounce: 400 * time.Millisecond, Channel: channel})
	if err := st.Load(ctx); err != nil {
		t.Fatal(err)
	}
	sub := st.Subscribe()
	defer sub.Close()
	done := make(chan struct{})
	go func() { st.Run(ctx); close(done) }()

	// Wait for the subscribe-triggered reload so later counts are clean.
	waitReloads(t, st, 2)

	publish := func(entity, id string) {
		if err := rdb.Publish(ctx, channel, `{"entity":"`+entity+`","id":"`+id+`"}`).Err(); err != nil {
			t.Fatal(err)
		}
	}

	// 1. Rebind-relevant change -> Updated.
	if _, err := pool.Exec(ctx, `UPDATE upstream_connections SET port = 2799 WHERE id = $1`, s.conn); err != nil {
		t.Fatal(err)
	}
	publish("upstream_connections", s.conn)
	d := waitDiff(t, sub, func(d ConnDiff) bool { return has(d.Updated, s.conn) })
	if d.New.Connection(s.conn).Port != 2799 || st.Current().Connection(s.conn).Port != 2799 {
		t.Fatal("new snapshot not visible")
	}

	// 2. Password rotation -> Updated (password participates in SessionConfigEqual).
	pw2, _ := c.EncryptString("newpw")
	if _, err := pool.Exec(ctx, `UPDATE upstream_connections SET password_enc = $2 WHERE id = $1`, s.conn, pw2); err != nil {
		t.Fatal(err)
	}
	publish("upstream_connections", s.conn)
	waitDiff(t, sub, func(d ConnDiff) bool { return has(d.Updated, s.conn) && d.New.Connection(s.conn).Password == "newpw" })

	// 3. Insert + delete -> Added / Removed.
	newConn := uuid.NewString()
	if _, err := pool.Exec(ctx, `INSERT INTO upstream_connections (id, name, host, port, system_id, password_enc, max_tps) VALUES ($1, 'new-'||$2, 'h2', 2776, 'n'||$2, $3, 5)`, newConn, randHex(8), pw2); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM upstream_connections WHERE id = $1`, s.badConn); err != nil {
		t.Fatal(err)
	}
	publish("upstream_connections", "")
	waitDiff(t, sub, func(d ConnDiff) bool { return has(d.Added, newConn) && has(d.Removed, s.badConn) })

	// 4. Non-connection change: reload happens, no diff delivered.
	if _, err := pool.Exec(ctx, `UPDATE organizations SET brand_name = 'NewBrand' WHERE id = $1`, s.client); err != nil {
		t.Fatal(err)
	}
	publish("organizations", s.client)
	deadline := time.Now().Add(5 * time.Second)
	for st.Current().Org(s.client).BrandName != "NewBrand" {
		if time.Now().After(deadline) {
			t.Fatal("org change not reloaded")
		}
		time.Sleep(20 * time.Millisecond)
	}
	select {
	case d := <-sub.C:
		if has(d.Updated, s.conn) || has(d.Added, newConn) {
			t.Fatalf("spurious diff for our connections: %v", d)
		}
	case <-time.After(300 * time.Millisecond):
	}

	// 5. Burst coalescing: 40 messages over ~200ms -> at most 2 reloads
	// (trailing debounce 100ms, capped at 400ms).
	before, _, _ := st.Stats()
	for i := 0; i < 40; i++ {
		publish("routes", "")
		time.Sleep(5 * time.Millisecond)
	}
	time.Sleep(900 * time.Millisecond)
	after, failures, lastErr := st.Stats()
	if n := after - before; n < 1 || n > 2 {
		t.Fatalf("burst of 40 invalidations caused %d reloads", n)
	}
	if lastErr != nil || failures != 0 {
		t.Fatalf("reload errors: %d %v", failures, lastErr)
	}

	cancel()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("Run did not stop")
	}
}

func waitReloads(t *testing.T, st *Store, n uint64) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		if r, _, _ := st.Stats(); r >= n {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("reload count never reached %d", n)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestPeriodicReloadAndFailureKeepsSnapshot(t *testing.T) {
	pool, _ := testEnv(t)
	c := testCipher(t)
	s := seed(t, pool, c)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	st := New(pool, nil, c, Options{ReloadInterval: 150 * time.Millisecond})
	if err := st.Load(ctx); err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	go func() { st.Run(ctx); close(done) }()
	if _, err := pool.Exec(ctx, `UPDATE routes SET enabled = false WHERE id = $1`, s.route); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(3 * time.Second)
	for st.Current().Route(s.route).Enabled {
		if time.Now().After(deadline) {
			t.Fatal("periodic reload did not pick up change")
		}
		time.Sleep(20 * time.Millisecond)
	}
	cancel()
	<-done

	// A failing load keeps the previous snapshot.
	prev := st.Current()
	closed, _ := pgxpool.New(context.Background(), pool.Config().ConnString())
	closed.Close()
	st2 := New(closed, nil, c, Options{})
	st2.cur.Store(prev)
	if err := st2.Load(context.Background()); err == nil {
		t.Fatal("expected load error")
	}
	if st2.Current() != prev {
		t.Fatal("snapshot replaced after failed load")
	}
	if _, failures, lastErr := st2.Stats(); failures != 1 || lastErr == nil {
		t.Fatal("failure not recorded")
	}
}
