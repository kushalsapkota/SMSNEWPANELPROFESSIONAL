package e2e

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"smsgw/engine/internal/app"
	"smsgw/engine/internal/config"
	"smsgw/engine/internal/crypto"
	"smsgw/engine/internal/webhook"
)

// world is the shared fixture built by TestMain.
type world struct {
	pool      *pgxpool.Pool
	app       *app.App
	appCancel context.CancelFunc
	appDone   chan error
	token     string
	cipher    *crypto.Cipher
	binDir    string

	simA, simB *sim

	ids        ids
	hooks      *hookRecorder
	hookServer *httptest.Server
	logBuf     *syncBuffer
	invalidate string // cfg:invalidate channel of this engine
	redisURL   string
}

type ids struct {
	admin, reseller, client, suspended, limited, poor string
	connA, connB, connDown                            string
	routeMain, routeOTP, routeB, routeDown            string
	sysID, sysPW, suspSysID                           string
	kickOrg, kickSysID                                string
	webhookSecret                                     string
}

var w *world

type syncBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuffer) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

// --- smsc-sim processes ------------------------------------------------------

type sim struct {
	cmd      *exec.Cmd
	smpp     string
	http     string
	out      *syncBuffer
	systemID string
	password string
}

func freePort() (int, error) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port, nil
}

func startSim(bin, systemID, password string) (*sim, error) {
	sp, err := freePort()
	if err != nil {
		return nil, err
	}
	hp, err := freePort()
	if err != nil {
		return nil, err
	}
	s := &sim{smpp: fmt.Sprintf("127.0.0.1:%d", sp), http: fmt.Sprintf("127.0.0.1:%d", hp), out: &syncBuffer{},
		systemID: systemID, password: password}
	s.cmd = exec.Command(bin, "-listen", s.smpp, "-http", s.http, "-system-id", systemID, "-password", password,
		"-dlr-delay", "100ms", "-log-level", "warn")
	s.cmd.Stdout, s.cmd.Stderr = s.out, s.out
	if err := s.cmd.Start(); err != nil {
		return nil, err
	}
	deadline := time.Now().Add(10 * time.Second)
	for {
		resp, err := http.Get("http://" + s.http + "/health")
		if err == nil {
			resp.Body.Close()
			return s, nil
		}
		if time.Now().After(deadline) {
			s.stop()
			return nil, fmt.Errorf("smsc-sim did not start: %v\n%s", err, s.out.String())
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func (s *sim) stop() {
	if s == nil || s.cmd == nil || s.cmd.Process == nil {
		return
	}
	_ = s.cmd.Process.Signal(syscall.SIGTERM)
	done := make(chan struct{})
	go func() { _ = s.cmd.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		_ = s.cmd.Process.Kill()
		<-done
	}
}

type simRecord struct {
	Source       string   `json:"source"`
	SourceTON    uint8    `json:"source_ton"`
	Dest         string   `json:"dest"`
	DestTON      uint8    `json:"dest_ton"`
	Text         string   `json:"text"`
	DataCoding   uint8    `json:"data_coding"`
	ESMClass     uint8    `json:"esm_class"`
	RegDelivery  uint8    `json:"registered_delivery"`
	Parts        int      `json:"parts"`
	Multipart    string   `json:"multipart"`
	SMSCIDs      []string `json:"smsc_ids"`
	SubmitStatus string   `json:"submit_status"`
	DLRsSent     int      `json:"dlrs_sent"`
}

func (s *sim) messages(dest string) ([]simRecord, error) {
	resp, err := http.Get("http://" + s.http + "/messages?dest=" + dest)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var out struct {
		Messages []simRecord `json:"messages"`
	}
	return out.Messages, json.NewDecoder(resp.Body).Decode(&out)
}

// --- webhook receiver --------------------------------------------------------

type hookRecorder struct {
	mu     sync.Mutex
	secret string
	calls  []hookCall
}

type hookCall struct {
	ValidSig bool
	Body     map[string]any
}

func (h *hookRecorder) ServeHTTP(rw http.ResponseWriter, r *http.Request) {
	b, _ := io.ReadAll(r.Body)
	var m map[string]any
	_ = json.Unmarshal(b, &m)
	h.mu.Lock()
	h.calls = append(h.calls, hookCall{
		ValidSig: webhook.Verify(h.secret, r.Header.Get("X-Webhook-Timestamp"), r.Header.Get("X-Webhook-Signature"), b),
		Body:     m,
	})
	h.mu.Unlock()
	rw.WriteHeader(http.StatusOK)
}

func (h *hookRecorder) find(messageID string) []hookCall {
	h.mu.Lock()
	defer h.mu.Unlock()
	var out []hookCall
	for _, c := range h.calls {
		if c.Body["message_id"] == messageID {
			out = append(out, c)
		}
	}
	return out
}

// --- setup -------------------------------------------------------------------

func randHex(n int) string {
	b := make([]byte, (n+1)/2)
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

func goBin() string {
	p := filepath.Join(runtime.GOROOT(), "bin", "go")
	if _, err := os.Stat(p); err == nil {
		return p
	}
	return "go"
}

func moduleRoot() string {
	_, file, _, _ := runtime.Caller(0)
	return filepath.Dir(filepath.Dir(file))
}

func openDB(ctx context.Context, dsn string) (*pgxpool.Pool, error) {
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		return nil, err
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, err
	}
	return pool, nil
}

func TestMain(m *testing.M) {
	code, err := setup()
	if err != nil {
		fmt.Fprintln(os.Stderr, "e2e setup failed:", err)
		teardown()
		os.Exit(1)
	}
	if code == 0 {
		code = m.Run()
	}
	teardown()
	os.Exit(code)
}

func setup() (int, error) {
	ctx := context.Background()
	dsn := os.Getenv("E2E_DATABASE_URL")
	if dsn == "" {
		dsn = "postgres://sms_engine_login:sms_engine_dev@localhost:5432/sms_flow"
	}
	redisURL := os.Getenv("E2E_REDIS_URL")
	if redisURL == "" {
		redisURL = "redis://localhost:6399/2"
	}
	pool, err := openDB(ctx, dsn)
	if err != nil && strings.Contains(err.Error(), "does not exist") {
		script := filepath.Join(filepath.Dir(moduleRoot()), "db", "reset-db.sh")
		if out, rerr := exec.Command(script, "sms_flow").CombinedOutput(); rerr != nil {
			return 1, fmt.Errorf("create sms_flow: %v: %s", rerr, out)
		}
		pool, err = openDB(ctx, dsn)
	}
	if err != nil {
		return 1, fmt.Errorf("postgres (run db/reset-db.sh sms_flow): %w", err)
	}
	w = &world{pool: pool, logBuf: &syncBuffer{}}

	// Binaries.
	w.binDir, err = os.MkdirTemp("", "smsgw-e2e-")
	if err != nil {
		return 1, err
	}
	for _, c := range []string{"smsc-sim", "smpp-cli"} {
		cmd := exec.Command(goBin(), "build", "-o", filepath.Join(w.binDir, c), "./cmd/"+c)
		cmd.Dir = moduleRoot()
		if out, err := cmd.CombinedOutput(); err != nil {
			return 1, fmt.Errorf("build %s: %v\n%s", c, err, out)
		}
	}
	if w.simA, err = startSim(filepath.Join(w.binDir, "smsc-sim"), "upA"+randHex(4), "pwA1"); err != nil {
		return 1, err
	}
	if w.simB, err = startSim(filepath.Join(w.binDir, "smsc-sim"), "upB"+randHex(4), "pwB1"); err != nil {
		return 1, err
	}

	key := make([]byte, 32)
	_, _ = rand.Read(key)
	w.cipher, _ = crypto.NewCipher(key)
	w.token = "e2e-token-" + randHex(24)
	w.hooks = &hookRecorder{secret: "whsec_" + randHex(16)}
	w.hookServer = httptest.NewServer(w.hooks)

	if err := seed(ctx); err != nil {
		return 1, fmt.Errorf("seed: %w", err)
	}

	env := map[string]string{
		"DATABASE_URL": dsn, "REDIS_URL": redisURL, "INTERNAL_TOKEN": w.token,
		"APP_ENC_KEY":      base64.StdEncoding.EncodeToString(key),
		"ENGINE_HTTP_ADDR": "127.0.0.1:0", "ENGINE_SMPP_ADDR": "127.0.0.1:0", "ENGINE_METRICS_ADDR": "127.0.0.1:0",
		"ENGINE_CDR_FLUSH_INTERVAL": "30ms", "ENGINE_BALANCE_SYNC_INTERVAL": "100ms",
		"ENGINE_DISPATCH_CLAIM_IDLE": "5s", "ENGINE_INSTANCE_ID": "e2e-" + randHex(6),
		"ENGINE_SHUTDOWN_TIMEOUT": "10s", "LOG_LEVEL": "info", "LOG_FORMAT": "text",
		// the webhook receiver is a local httptest server (SSRF guard off for tests)
		"WEBHOOK_ALLOW_PRIVATE_TARGETS": "1",
	}
	cfg, err := config.LoadFrom(func(k string) (string, bool) { v, ok := env[k]; return v, ok })
	if err != nil {
		return 1, err
	}
	pfx := "e2e:" + randHex(8) + ":"
	w.invalidate = pfx + "cfg:invalidate"
	w.redisURL = redisURL
	log := slog.New(slog.NewTextHandler(w.logBuf, &slog.HandlerOptions{Level: slog.LevelInfo}))
	w.app, err = app.New(ctx, cfg, log, app.Overrides{
		InvalidateChannel: pfx + "cfg:invalidate", DLROutStream: pfx + "q:dlr-out", WebhookKeyPrefix: pfx + "wh:",
		BalanceDirtyKey: pfx + "bal:dirty", WebhookBaseBackoff: 200 * time.Millisecond, WebhookPollInterval: 20 * time.Millisecond,
		DLRRetryIdle: 2 * time.Second, SessionSweep: 200 * time.Millisecond,
		// HTTP connections: poll DLRs every 500ms (http_adapter_test.go).
		HTTPDLRPollTick: 100 * time.Millisecond, HTTPDLRPollInterval: 500 * time.Millisecond,
		// Redis db 2 is shared with the dispatch unit tests: never adopt their streams.
		DispatchScanInterval: -1,
	})
	if err != nil {
		return 1, err
	}
	actx, cancel := context.WithCancel(context.Background())
	w.appCancel = cancel
	w.appDone = make(chan error, 1)
	go func() { w.appDone <- w.app.Run(actx) }()

	// Wait for both upstream connections to bind.
	deadline := time.Now().Add(15 * time.Second)
	for {
		st := connStates()
		if st[w.ids.connA] == "BOUND" && st[w.ids.connB] == "BOUND" {
			break
		}
		if time.Now().After(deadline) {
			return 1, fmt.Errorf("upstream connections not bound: %v\n%s", st, w.logBuf.String())
		}
		time.Sleep(50 * time.Millisecond)
	}
	return 0, nil
}

func teardown() {
	if w == nil {
		return
	}
	if w.appCancel != nil {
		w.appCancel()
		select {
		case <-w.appDone:
		case <-time.After(20 * time.Second):
			fmt.Fprintln(os.Stderr, "engine did not stop in time")
		}
	}
	w.simA.stop()
	w.simB.stop()
	if w.pool != nil && w.ids.admin != "" {
		cleanupSeed()
	}
	if w.hookServer != nil {
		w.hookServer.Close()
	}
	if w.pool != nil {
		w.pool.Close()
	}
	if w.binDir != "" {
		os.RemoveAll(w.binDir)
	}
}

// cleanupSeed removes everything the run created (orgs cascade to their
// balances, assignments, accounts, webhooks and delivery logs).
func cleanupSeed() {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	id := w.ids
	clients := []string{id.client, id.suspended, id.limited, id.poor, id.kickOrg}
	orgs := append(append([]string(nil), clients...), id.reseller, id.admin)
	for _, q := range []struct {
		sql string
		arg []string
	}{
		{`DELETE FROM message_logs WHERE org_id = ANY($1::uuid[])`, orgs},
		{`DELETE FROM message_stats_hourly WHERE org_id = ANY($1::uuid[])`, orgs},
		{`DELETE FROM organizations WHERE id = ANY($1::uuid[])`, clients},
		{`DELETE FROM organizations WHERE id = ANY($1::uuid[])`, []string{id.reseller}},
		{`DELETE FROM organizations WHERE id = ANY($1::uuid[])`, []string{id.admin}},
		{`DELETE FROM routes WHERE id = ANY($1::uuid[])`, []string{id.routeMain, id.routeOTP, id.routeB, id.routeDown}},
		{`DELETE FROM upstream_connections WHERE id = ANY($1::uuid[])`, []string{id.connA, id.connB, id.connDown}},
	} {
		if _, err := w.pool.Exec(ctx, q.sql, q.arg); err != nil {
			fmt.Fprintln(os.Stderr, "e2e cleanup:", err)
		}
	}
}

// connStates maps connection id -> state; a connection whose sessions are
// not all bound reports "PARTIAL" instead of "BOUND".
func connStates() map[string]string {
	out := map[string]string{}
	var body struct {
		Connections []struct {
			ID       string `json:"connection_id"`
			State    string `json:"state"`
			Sessions []struct {
				State string `json:"state"`
			} `json:"sessions"`
		} `json:"connections"`
	}
	if st, _ := call("GET", "/internal/v1/connections/status", nil, &body); st != 200 {
		return out
	}
	for _, c := range body.Connections {
		out[c.ID] = c.State
		for _, s := range c.Sessions {
			if c.State == "BOUND" && !strings.HasPrefix(s.State, "BOUND") {
				out[c.ID] = "PARTIAL"
			}
		}
	}
	return out
}

const (
	clientBalance   = 50_000_000
	resellerBalance = 80_000_000
	rateMainClient  = 5000
	rateMainRes     = 2000
	rateOTPClient   = 7000
	rateOTPRes      = 3000
)

func seed(ctx context.Context) error {
	id := &w.ids
	*id = ids{admin: uuid.NewString(), reseller: uuid.NewString(), client: uuid.NewString(), suspended: uuid.NewString(),
		limited: uuid.NewString(), poor: uuid.NewString(),
		connA: uuid.NewString(), connB: uuid.NewString(), connDown: uuid.NewString(),
		routeMain: uuid.NewString(), routeOTP: uuid.NewString(), routeB: uuid.NewString(), routeDown: uuid.NewString(),
		sysID: "e2e" + randHex(8), sysPW: "pw12345", suspSysID: "sus" + randHex(8), webhookSecret: w.hooks.secret,
		kickOrg: uuid.NewString(), kickSysID: "kick" + randHex(8)}
	sfx := randHex(8)
	encA, _ := w.cipher.EncryptString(w.simA.password)
	encB, _ := w.cipher.EncryptString(w.simB.password)
	encHook, _ := w.cipher.EncryptString(id.webhookSecret)
	hash, err := crypto.HashPassword(id.sysPW)
	if err != nil {
		return err
	}
	host := func(a string) (string, int) {
		h, p, _ := net.SplitHostPort(a)
		n, _ := strconv.Atoi(p)
		return h, n
	}
	ah, ap := host(w.simA.smpp)
	bh, bp := host(w.simB.smpp)
	downPort, _ := freePort()
	stmts := []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO organizations (id, role, name) VALUES ($1, 'SUPER_ADMIN', $2)`, []any{id.admin, "adm-" + sfx}},
		{`INSERT INTO organizations (id, role, parent_id, name, brand_name, max_tps, smpp_enabled) VALUES ($1, 'RESELLER', $2, $3, 'ResBrand', 200, true)`, []any{id.reseller, id.admin, "res-" + sfx}},
		{`INSERT INTO organizations (id, role, parent_id, name, brand_name, max_tps, smpp_enabled) VALUES ($1, 'CLIENT', $2, $3, 'Acme', 200, true)`, []any{id.client, id.reseller, "cli-" + sfx}},
		{`INSERT INTO organizations (id, role, parent_id, name, status, suspended_reason, smpp_enabled) VALUES ($1, 'CLIENT', $2, $3, 'SUSPENDED', 'unpaid', true)`, []any{id.suspended, id.reseller, "sus-" + sfx}},
		{`INSERT INTO organizations (id, role, parent_id, name, max_tps) VALUES ($1, 'CLIENT', $2, $3, 2)`, []any{id.limited, id.reseller, "lim-" + sfx}},
		{`INSERT INTO organizations (id, role, parent_id, name) VALUES ($1, 'CLIENT', $2, $3)`, []any{id.poor, id.reseller, "poor-" + sfx}},
		{`INSERT INTO organizations (id, role, parent_id, name, smpp_enabled) VALUES ($1, 'CLIENT', $2, $3, true)`, []any{id.kickOrg, id.reseller, "kick-" + sfx}},
		{`INSERT INTO accounts_balance (org_id, balance_micros) VALUES ($1, $2)`, []any{id.reseller, resellerBalance}},
		{`INSERT INTO accounts_balance (org_id, balance_micros) VALUES ($1, $2)`, []any{id.client, clientBalance}},
		{`INSERT INTO accounts_balance (org_id, balance_micros) VALUES ($1, $2)`, []any{id.suspended, clientBalance}},
		{`INSERT INTO accounts_balance (org_id, balance_micros) VALUES ($1, $2)`, []any{id.limited, clientBalance}},
		{`INSERT INTO accounts_balance (org_id, balance_micros) VALUES ($1, 1000)`, []any{id.poor}},

		{`INSERT INTO upstream_connections (id, name, host, port, system_id, password_enc, max_tps, sessions, submit_timeout_ms, multipart_mode, enquire_link_interval_s, reconnect_min_s, reconnect_max_s)
		  VALUES ($1, $2, $3, $4, $5, $6, 200, 2, 3000, 'UDH', 5, 1, 2)`, []any{id.connA, "simA-" + sfx, ah, ap, w.simA.systemID, encA}},
		{`INSERT INTO upstream_connections (id, name, host, port, system_id, password_enc, max_tps, sessions, submit_timeout_ms, multipart_mode, enquire_link_interval_s, reconnect_min_s, reconnect_max_s)
		  VALUES ($1, $2, $3, $4, $5, $6, 200, 1, 3000, 'SAR', 5, 1, 2)`, []any{id.connB, "simB-" + sfx, bh, bp, w.simB.systemID, encB}},
		{`INSERT INTO upstream_connections (id, name, host, port, system_id, password_enc, max_tps, sessions, reconnect_min_s, reconnect_max_s)
		  VALUES ($1, $2, '127.0.0.1', $3, 'nobody', $4, 10, 1, 1, 2)`, []any{id.connDown, "down-" + sfx, downPort, encA}},
		{`INSERT INTO upstream_rates (connection_id, prefix, cost_micros, effective_from) VALUES ($1, '', 1000, now() - interval '1 day')`, []any{id.connA}},
		{`INSERT INTO upstream_rates (connection_id, prefix, cost_micros, effective_from) VALUES ($1, '91', 800, now() - interval '1 day')`, []any{id.connA}},
		{`INSERT INTO upstream_rates (connection_id, prefix, cost_micros, effective_from) VALUES ($1, '', 1500, now() - interval '1 day')`, []any{id.connB}},

		{`INSERT INTO routes (id, name) VALUES ($1, $2)`, []any{id.routeMain, "main-" + sfx}},
		{`INSERT INTO routes (id, name, template_mode, template_fallback) VALUES ($1, $2, true, 'REJECT')`, []any{id.routeOTP, "otp-" + sfx}},
		{`INSERT INTO routes (id, name) VALUES ($1, $2)`, []any{id.routeB, "b-" + sfx}},
		{`INSERT INTO routes (id, name) VALUES ($1, $2)`, []any{id.routeDown, "down-" + sfx}},
		{`INSERT INTO route_connections (route_id, connection_id, priority) VALUES ($1, $2, 1)`, []any{id.routeMain, id.connA}},
		{`INSERT INTO route_connections (route_id, connection_id, priority) VALUES ($1, $2, 2)`, []any{id.routeMain, id.connB}},
		{`INSERT INTO route_connections (route_id, connection_id, priority) VALUES ($1, $2, 1)`, []any{id.routeOTP, id.connA}},
		{`INSERT INTO route_connections (route_id, connection_id, priority) VALUES ($1, $2, 1)`, []any{id.routeB, id.connB}},
		{`INSERT INTO route_connections (route_id, connection_id, priority) VALUES ($1, $2, 1)`, []any{id.routeDown, id.connDown}},
		{`INSERT INTO route_connections (route_id, connection_id, priority) VALUES ($1, $2, 2)`, []any{id.routeDown, id.connA}},
		{`INSERT INTO route_templates (route_id, name, template_body) VALUES ($1, 'otp', '{brand}: your code is {otp}')`, []any{id.routeOTP}},
	}
	// Reseller assignments, then client ones (the trigger requires the reseller's).
	for _, r := range []string{id.routeMain, id.routeB, id.routeDown} {
		stmts = append(stmts, struct {
			sql  string
			args []any
		}{`INSERT INTO org_route_assignments (org_id, route_id, prefix, rate_micros) VALUES ($1, $2, '', $3)`, []any{id.reseller, r, rateMainRes}})
	}
	stmts = append(stmts, struct {
		sql  string
		args []any
	}{`INSERT INTO org_route_assignments (org_id, route_id, prefix, rate_micros) VALUES ($1, $2, '91', $3)`, []any{id.reseller, id.routeOTP, rateOTPRes}})
	for _, org := range []string{id.client, id.suspended, id.limited, id.poor} {
		stmts = append(stmts,
			struct {
				sql  string
				args []any
			}{`INSERT INTO org_route_assignments (org_id, route_id, prefix, rate_micros) VALUES ($1, $2, '', $3)`, []any{org, id.routeMain, rateMainClient}},
			struct {
				sql  string
				args []any
			}{`INSERT INTO org_route_assignments (org_id, route_id, prefix, rate_micros) VALUES ($1, $2, '91', $3)`, []any{org, id.routeOTP, rateOTPClient}},
			struct {
				sql  string
				args []any
			}{`INSERT INTO org_route_assignments (org_id, route_id, prefix, rate_micros) VALUES ($1, $2, '33', $3)`, []any{org, id.routeB, rateMainClient}},
			struct {
				sql  string
				args []any
			}{`INSERT INTO org_route_assignments (org_id, route_id, prefix, rate_micros) VALUES ($1, $2, '49', $3)`, []any{org, id.routeDown, rateMainClient}},
		)
	}
	stmts = append(stmts,
		struct {
			sql  string
			args []any
		}{`INSERT INTO smpp_accounts (org_id, system_id, password_hash, allowed_bind_types) VALUES ($1, $2, $3, ARRAY['TX','RX','TRX']::bind_type[])`, []any{id.client, id.sysID, hash}},
		struct {
			sql  string
			args []any
		}{`INSERT INTO smpp_accounts (org_id, system_id, password_hash) VALUES ($1, $2, $3)`, []any{id.suspended, id.suspSysID, hash}},
		struct {
			sql  string
			args []any
		}{`INSERT INTO smpp_accounts (org_id, system_id, password_hash, max_binds) VALUES ($1, $2, $3, 4)`, []any{id.kickOrg, id.kickSysID, hash}},
		struct {
			sql  string
			args []any
		}{`INSERT INTO webhooks (org_id, url, secret_enc, events, max_retries) VALUES ($1, $2, $3, ARRAY['dlr'], 3)`, []any{id.client, w.hookServer.URL + "/hook", encHook}},
	)
	for _, st := range stmts {
		if _, err := w.pool.Exec(ctx, st.sql, st.args...); err != nil {
			return fmt.Errorf("%s: %w", st.sql, err)
		}
	}
	return nil
}

// --- HTTP helpers ------------------------------------------------------------

func call(method, path string, body any, out any) (int, error) {
	var r io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return 0, err
		}
		r = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, "http://"+w.app.HTTPAddr()+path, r)
	if err != nil {
		return 0, err
	}
	req.Header.Set("X-Internal-Token", w.token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	if out != nil {
		if err := json.Unmarshal(b, out); err != nil {
			return resp.StatusCode, fmt.Errorf("decode %q: %w", b, err)
		}
	}
	return resp.StatusCode, nil
}

func waitFor(t *testing.T, what string, timeout time.Duration, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(25 * time.Millisecond)
	}
}

func balance(t *testing.T, org string) int64 {
	t.Helper()
	var b struct {
		Balance int64 `json:"balance_micros"`
	}
	if st, err := call("GET", "/internal/v1/balance/"+org, nil, &b); err != nil || st != 200 {
		t.Fatalf("balance %s: %d %v", org, st, err)
	}
	return b.Balance
}

type cdrRow struct {
	Status, Channel, OrigText, SentText, Encoding, ConnectionID, ErrorCode, DLRStat, DLRErr, ResellerID, ClientRef string
	Parts                                                                                                          int
	OTPExtracted                                                                                                   *bool
	SMSCIDs                                                                                                        []string
	ClientCost, ResellerCost, RouteCost                                                                            *int64
	Refunded                                                                                                       bool
	SubmittedAt, DLRAt                                                                                             *time.Time
	SourceTON, DestTON                                                                                             int
	Country                                                                                                        string
}

func cdrOf(t *testing.T, msgID string) (cdrRow, bool) {
	t.Helper()
	var r cdrRow
	err := w.pool.QueryRow(context.Background(), `
		SELECT status::text, channel::text, orig_text, coalesce(sent_text,''), encoding::text, coalesce(connection_id::text,''),
		       coalesce(error_code,''), coalesce(dlr_stat,''), coalesce(dlr_err,''), coalesce(reseller_id::text,''), coalesce(client_msg_ref,''),
		       parts, otp_extracted, smsc_msg_ids, client_cost_micros, reseller_cost_micros, route_cost_micros, refunded,
		       submitted_at, dlr_received_at, source_ton, dest_ton, coalesce(country_iso,'')
		  FROM message_logs WHERE id = $1`, msgID).Scan(&r.Status, &r.Channel, &r.OrigText, &r.SentText, &r.Encoding,
		&r.ConnectionID, &r.ErrorCode, &r.DLRStat, &r.DLRErr, &r.ResellerID, &r.ClientRef, &r.Parts, &r.OTPExtracted,
		&r.SMSCIDs, &r.ClientCost, &r.ResellerCost, &r.RouteCost, &r.Refunded, &r.SubmittedAt, &r.DLRAt,
		&r.SourceTON, &r.DestTON, &r.Country)
	if err != nil {
		return r, false
	}
	return r, true
}

func waitCDR(t *testing.T, msgID, status string) cdrRow {
	t.Helper()
	var r cdrRow
	waitFor(t, "CDR "+msgID+" "+status, 15*time.Second, func() bool {
		var ok bool
		r, ok = cdrOf(t, msgID)
		return ok && r.Status == status
	})
	return r
}

func dumpLogsOnFailure(t *testing.T) {
	t.Cleanup(func() {
		if t.Failed() {
			t.Logf("engine log:\n%s", tail(w.logBuf.String(), 60))
		}
	})
}

func tail(s string, n int) string {
	lines := strings.Split(s, "\n")
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return strings.Join(lines, "\n")
}
