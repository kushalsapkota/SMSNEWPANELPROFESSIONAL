// Package config loads engine configuration from environment variables
// (CONTRACTS §1) with sane defaults for every engine tunable. Load collects
// every problem and returns them together, so a misconfigured deploy fails
// once with a complete list instead of one variable at a time.
package config

import (
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"smsgw/engine/internal/crypto"
)

// Config is the full engine configuration. Durations are Go durations
// ("250ms", "60s", "72h"); a bare integer is read as seconds.
type Config struct {
	// Shared (CONTRACTS §1)
	DatabaseURL   string // DATABASE_URL (role with sms_engine / BYPASSRLS)
	RedisURL      string // REDIS_URL
	InternalToken string // INTERNAL_TOKEN
	AppEncKey     []byte // APP_ENC_KEY, base64-decoded (32 bytes)

	// Listeners
	HTTPAddr    string // ENGINE_HTTP_ADDR, default ":8081"
	SMPPAddr    string // ENGINE_SMPP_ADDR, default ":2775"
	MetricsAddr string // ENGINE_METRICS_ADDR, default ":9100"

	// Postgres / Redis pools
	DBMaxConns    int32         // ENGINE_DB_MAX_CONNS, default 20
	DBMinConns    int32         // ENGINE_DB_MIN_CONNS, default 2
	DBConnTimeout time.Duration // ENGINE_DB_CONNECT_TIMEOUT, default 5s
	RedisPoolSize int           // ENGINE_REDIS_POOL_SIZE, default 0 (go-redis default: 10/CPU)
	RedisTimeout  time.Duration // ENGINE_REDIS_TIMEOUT (dial/read/write), default 3s

	// Config snapshot (store)
	ConfigReloadInterval time.Duration // ENGINE_CONFIG_RELOAD_INTERVAL, default 60s
	ConfigDebounce       time.Duration // ENGINE_CONFIG_DEBOUNCE, default 200ms
	ConfigMaxDebounce    time.Duration // ENGINE_CONFIG_MAX_DEBOUNCE, default 2s
	// CFG_INVALIDATE_CHANNEL: Redis pub/sub channel for config invalidation. Must match the
	// api's CFG_INVALIDATE_CHANNEL. Default "cfg:invalidate" (store.InvalidateChannel). Set a
	// unique value per stack when several stacks share one Redis server, so each only reacts to
	// its own invalidations.
	ConfigInvalidateChannel string

	// Billing
	BalanceSyncInterval time.Duration // ENGINE_BALANCE_SYNC_INTERVAL, default 2s
	BalanceFullSyncEach time.Duration // ENGINE_BALANCE_FULL_SYNC_INTERVAL, default 60s
	DebitTxnTTL         time.Duration // ENGINE_DEBIT_TXN_TTL (refund window), default 72h
	CreditIdemTTL       time.Duration // ENGINE_CREDIT_IDEM_TTL, default 720h (30d)

	// SMPP server (client side)
	BindCacheTTL       time.Duration // ENGINE_BIND_CACHE_TTL, default 10m
	SMPPEnquireTimeout time.Duration // ENGINE_SMPP_IDLE_TIMEOUT, default 90s (no PDU from client)
	SMPPBindTimeout    time.Duration // ENGINE_SMPP_BIND_TIMEOUT, default 10s (first PDU must be a bind)
	SMPPWriteTimeout   time.Duration // ENGINE_SMPP_WRITE_TIMEOUT, default 10s
	SMPPMaxSessions    int           // ENGINE_SMPP_MAX_SESSIONS, default 5000
	SMPPDeliverWindow  int           // ENGINE_SMPP_DELIVER_WINDOW, default 10 unacked deliver_sm per session
	SMPPDeliverTimeout time.Duration // ENGINE_SMPP_DELIVER_TIMEOUT, default 30s
	SMPPServerSystemID string        // ENGINE_SMPP_SYSTEM_ID, default "SMSGW"

	// HTTP server
	HTTPReadTimeout  time.Duration // ENGINE_HTTP_READ_TIMEOUT, default 15s
	HTTPWriteTimeout time.Duration // ENGINE_HTTP_WRITE_TIMEOUT, default 60s
	HTTPIdleTimeout  time.Duration // ENGINE_HTTP_IDLE_TIMEOUT, default 120s
	HTTPMaxBodyBytes int64         // ENGINE_HTTP_MAX_BODY_BYTES, default 8 MiB

	// Dispatch / DLR
	DispatchBatch       int           // ENGINE_DISPATCH_BATCH, default 100 stream entries per read
	DispatchBlock       time.Duration // ENGINE_DISPATCH_BLOCK, default 1s XREADGROUP block
	DispatchMaxFailover int           // ENGINE_DISPATCH_MAX_FAILOVER, default 2
	DispatchClaimIdle   time.Duration // ENGINE_DISPATCH_CLAIM_IDLE, default 60s (XAUTOCLAIM)
	MsgStateTTL         time.Duration // ENGINE_MSG_STATE_TTL (msg:/dlrmap: keys), default 72h
	WebhookTimeout      time.Duration // ENGINE_WEBHOOK_TIMEOUT, default 10s
	WebhookWorkers      int           // ENGINE_WEBHOOK_WORKERS, default 16
	// WebhookAllowPrivate (WEBHOOK_ALLOW_PRIVATE_TARGETS=1, same name as the
	// api) lets webhooks reach loopback / private / reserved addresses. Dev and
	// tests only; off = SSRF guard on (webhook.Options.BlockPrivate).
	WebhookAllowPrivate bool
	// PublicAPIBaseURL (PUBLIC_API_BASE_URL, optional, same name as the api):
	// the public base of the provider DLR callback URL
	// (<base>/v1/provider-dlr/<dlr_token>), sent to adapters that take a
	// callback URL per request. Empty = not sent.
	PublicAPIBaseURL string
	TorProxyURL      string        // TOR_PROXY_URL, default "socks5://127.0.0.1:9050"
	CDRFlushInterval time.Duration // ENGINE_CDR_FLUSH_INTERVAL, default 250ms
	CDRBatchSize     int           // ENGINE_CDR_BATCH_SIZE, default 500

	// Process
	ShutdownTimeout time.Duration // ENGINE_SHUTDOWN_TIMEOUT, default 20s
	LogLevel        string        // LOG_LEVEL: debug|info|warn|error, default info
	LogFormat       string        // LOG_FORMAT: json|text, default json
	InstanceID      string        // ENGINE_INSTANCE_ID, default hostname (Redis consumer name)
}

// Getenv abstracts os.LookupEnv for tests.
type Getenv func(key string) (string, bool)

// Load reads the process environment.
func Load() (*Config, error) { return LoadFrom(os.LookupEnv) }

// LoadFrom reads configuration through getenv. The returned error (if any)
// wraps every individual problem; use errors.As with *ValidationError to get
// the list.
func LoadFrom(getenv Getenv) (*Config, error) {
	l := &loader{get: getenv}
	c := &Config{
		DatabaseURL:   l.str("DATABASE_URL", ""),
		RedisURL:      l.str("REDIS_URL", ""),
		InternalToken: l.str("INTERNAL_TOKEN", ""),

		HTTPAddr:    l.str("ENGINE_HTTP_ADDR", ":8081"),
		SMPPAddr:    l.str("ENGINE_SMPP_ADDR", ":2775"),
		MetricsAddr: l.str("ENGINE_METRICS_ADDR", ":9100"),

		DBMaxConns:    int32(l.int("ENGINE_DB_MAX_CONNS", 20, 1, 1000)),
		DBMinConns:    int32(l.int("ENGINE_DB_MIN_CONNS", 2, 0, 1000)),
		DBConnTimeout: l.dur("ENGINE_DB_CONNECT_TIMEOUT", 5*time.Second, time.Millisecond),
		RedisPoolSize: l.int("ENGINE_REDIS_POOL_SIZE", 0, 0, 10000),
		RedisTimeout:  l.dur("ENGINE_REDIS_TIMEOUT", 3*time.Second, time.Millisecond),

		ConfigReloadInterval: l.dur("ENGINE_CONFIG_RELOAD_INTERVAL", 60*time.Second, time.Second),
		ConfigDebounce:       l.dur("ENGINE_CONFIG_DEBOUNCE", 200*time.Millisecond, time.Millisecond),
		ConfigMaxDebounce:    l.dur("ENGINE_CONFIG_MAX_DEBOUNCE", 2*time.Second, time.Millisecond),
		// Default kept in sync with store.InvalidateChannel ("cfg:invalidate").
		ConfigInvalidateChannel: l.str("CFG_INVALIDATE_CHANNEL", "cfg:invalidate"),

		BalanceSyncInterval: l.dur("ENGINE_BALANCE_SYNC_INTERVAL", 2*time.Second, 10*time.Millisecond),
		BalanceFullSyncEach: l.dur("ENGINE_BALANCE_FULL_SYNC_INTERVAL", 60*time.Second, time.Second),
		DebitTxnTTL:         l.dur("ENGINE_DEBIT_TXN_TTL", 72*time.Hour, time.Second),
		CreditIdemTTL:       l.dur("ENGINE_CREDIT_IDEM_TTL", 30*24*time.Hour, time.Second),

		BindCacheTTL:       l.dur("ENGINE_BIND_CACHE_TTL", crypto.DefaultBindCacheTTL, time.Second),
		SMPPEnquireTimeout: l.dur("ENGINE_SMPP_IDLE_TIMEOUT", 90*time.Second, time.Second),
		SMPPBindTimeout:    l.dur("ENGINE_SMPP_BIND_TIMEOUT", 10*time.Second, time.Millisecond),
		SMPPWriteTimeout:   l.dur("ENGINE_SMPP_WRITE_TIMEOUT", 10*time.Second, time.Millisecond),
		SMPPMaxSessions:    l.int("ENGINE_SMPP_MAX_SESSIONS", 5000, 1, 1_000_000),
		SMPPDeliverWindow:  l.int("ENGINE_SMPP_DELIVER_WINDOW", 10, 1, 1000),
		SMPPDeliverTimeout: l.dur("ENGINE_SMPP_DELIVER_TIMEOUT", 30*time.Second, time.Millisecond),
		SMPPServerSystemID: l.str("ENGINE_SMPP_SYSTEM_ID", "SMSGW"),

		HTTPReadTimeout:  l.dur("ENGINE_HTTP_READ_TIMEOUT", 15*time.Second, time.Millisecond),
		HTTPWriteTimeout: l.dur("ENGINE_HTTP_WRITE_TIMEOUT", 60*time.Second, time.Millisecond),
		HTTPIdleTimeout:  l.dur("ENGINE_HTTP_IDLE_TIMEOUT", 120*time.Second, time.Millisecond),
		HTTPMaxBodyBytes: int64(l.int("ENGINE_HTTP_MAX_BODY_BYTES", 8<<20, 1024, 1<<30)),

		DispatchBatch:       l.int("ENGINE_DISPATCH_BATCH", 100, 1, 10000),
		DispatchBlock:       l.dur("ENGINE_DISPATCH_BLOCK", time.Second, time.Millisecond),
		DispatchMaxFailover: l.int("ENGINE_DISPATCH_MAX_FAILOVER", 2, 0, 10),
		DispatchClaimIdle:   l.dur("ENGINE_DISPATCH_CLAIM_IDLE", 60*time.Second, time.Second),
		MsgStateTTL:         l.dur("ENGINE_MSG_STATE_TTL", 72*time.Hour, time.Minute),
		WebhookTimeout:      l.dur("ENGINE_WEBHOOK_TIMEOUT", 10*time.Second, time.Millisecond),
		WebhookWorkers:      l.int("ENGINE_WEBHOOK_WORKERS", 16, 1, 1024),
		WebhookAllowPrivate: truthy(l.str("WEBHOOK_ALLOW_PRIVATE_TARGETS", "")),
		PublicAPIBaseURL:    strings.TrimRight(l.str("PUBLIC_API_BASE_URL", ""), "/"),
		TorProxyURL:         l.str("TOR_PROXY_URL", "socks5://127.0.0.1:9050"),
		CDRFlushInterval:    l.dur("ENGINE_CDR_FLUSH_INTERVAL", 250*time.Millisecond, time.Millisecond),
		CDRBatchSize:        l.int("ENGINE_CDR_BATCH_SIZE", 500, 1, 100000),

		ShutdownTimeout: l.dur("ENGINE_SHUTDOWN_TIMEOUT", 20*time.Second, time.Millisecond),
		LogLevel:        strings.ToLower(l.str("LOG_LEVEL", "info")),
		LogFormat:       strings.ToLower(l.str("LOG_FORMAT", "json")),
		InstanceID:      l.str("ENGINE_INSTANCE_ID", ""),
	}

	// Required shared settings.
	if c.DatabaseURL == "" {
		l.fail("DATABASE_URL", "is required")
	} else if u, err := url.Parse(c.DatabaseURL); err != nil || (u.Scheme != "postgres" && u.Scheme != "postgresql") {
		l.fail("DATABASE_URL", "must be a postgres:// or postgresql:// URL")
	}
	if c.RedisURL == "" {
		l.fail("REDIS_URL", "is required")
	} else if u, err := url.Parse(c.RedisURL); err != nil || (u.Scheme != "redis" && u.Scheme != "rediss" && u.Scheme != "unix") {
		l.fail("REDIS_URL", "must be a redis://, rediss:// or unix:// URL")
	}
	if c.InternalToken == "" {
		l.fail("INTERNAL_TOKEN", "is required")
	} else if len(c.InternalToken) < 16 {
		l.fail("INTERNAL_TOKEN", "must be at least 16 characters")
	}
	if raw, ok := getenv("APP_ENC_KEY"); !ok || strings.TrimSpace(raw) == "" {
		l.fail("APP_ENC_KEY", "is required (base64 of 32 random bytes)")
	} else if key, err := crypto.ParseKey(raw); err != nil {
		l.fail("APP_ENC_KEY", err.Error())
	} else {
		c.AppEncKey = key
	}

	for _, a := range []struct{ name, val string }{
		{"ENGINE_HTTP_ADDR", c.HTTPAddr}, {"ENGINE_SMPP_ADDR", c.SMPPAddr}, {"ENGINE_METRICS_ADDR", c.MetricsAddr},
	} {
		if _, port, err := net.SplitHostPort(a.val); err != nil {
			l.fail(a.name, fmt.Sprintf("must be host:port (%v)", err))
		} else if p, err := strconv.Atoi(port); err != nil || p < 0 || p > 65535 {
			l.fail(a.name, "port must be 0-65535")
		}
	}
	if c.PublicAPIBaseURL != "" {
		if u, err := url.Parse(c.PublicAPIBaseURL); err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
			l.fail("PUBLIC_API_BASE_URL", "must be an http(s) URL")
		}
	}
	if c.DBMinConns > c.DBMaxConns {
		l.fail("ENGINE_DB_MIN_CONNS", "must not exceed ENGINE_DB_MAX_CONNS")
	}
	if c.ConfigMaxDebounce < c.ConfigDebounce {
		l.fail("ENGINE_CONFIG_MAX_DEBOUNCE", "must be >= ENGINE_CONFIG_DEBOUNCE")
	}
	if len(c.SMPPServerSystemID) == 0 || len(c.SMPPServerSystemID) > 15 {
		l.fail("ENGINE_SMPP_SYSTEM_ID", "must be 1-15 characters")
	}
	switch c.LogLevel {
	case "debug", "info", "warn", "error":
	default:
		l.fail("LOG_LEVEL", "must be one of debug, info, warn, error")
	}
	switch c.LogFormat {
	case "json", "text":
	default:
		l.fail("LOG_FORMAT", "must be json or text")
	}
	if c.InstanceID == "" {
		h, err := os.Hostname()
		if err != nil || h == "" {
			h = "engine"
		}
		c.InstanceID = fmt.Sprintf("%s-%d", h, os.Getpid())
	}

	if len(l.errs) > 0 {
		return nil, &ValidationError{Problems: l.errs}
	}
	return c, nil
}

// Problem is a single invalid / missing variable.
type Problem struct {
	Var    string
	Reason string
}

// ValidationError lists every configuration problem found.
type ValidationError struct {
	Problems []Problem
}

func (e *ValidationError) Error() string {
	var b strings.Builder
	b.WriteString("invalid engine configuration:")
	for _, p := range e.Problems {
		fmt.Fprintf(&b, "\n  - %s %s", p.Var, p.Reason)
	}
	return b.String()
}

// Has reports whether variable name has a problem.
func (e *ValidationError) Has(name string) bool {
	for _, p := range e.Problems {
		if p.Var == name {
			return true
		}
	}
	return false
}

// IsValidation reports whether err is a *ValidationError.
func IsValidation(err error) bool {
	var v *ValidationError
	return errors.As(err, &v)
}

type loader struct {
	get  Getenv
	errs []Problem
}

func (l *loader) fail(name, reason string) {
	l.errs = append(l.errs, Problem{Var: name, Reason: reason})
}

func (l *loader) raw(name string) (string, bool) {
	v, ok := l.get(name)
	if !ok {
		return "", false
	}
	v = strings.TrimSpace(v)
	return v, v != ""
}

func (l *loader) str(name, def string) string {
	if v, ok := l.raw(name); ok {
		return v
	}
	return def
}

func (l *loader) int(name string, def, min, max int) int {
	v, ok := l.raw(name)
	if !ok {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		l.fail(name, fmt.Sprintf("must be an integer, got %q", v))
		return def
	}
	if n < min || n > max {
		l.fail(name, fmt.Sprintf("must be between %d and %d, got %d", min, max, n))
		return def
	}
	return n
}

func (l *loader) dur(name string, def, min time.Duration) time.Duration {
	v, ok := l.raw(name)
	if !ok {
		return def
	}
	var d time.Duration
	if n, err := strconv.ParseInt(v, 10, 64); err == nil {
		d = time.Duration(n) * time.Second
	} else if d, err = time.ParseDuration(v); err != nil {
		l.fail(name, fmt.Sprintf("must be a duration like 250ms/60s/72h, got %q", v))
		return def
	}
	if d < min {
		l.fail(name, fmt.Sprintf("must be at least %s, got %s", min, d))
		return def
	}
	return d
}

// truthy: "1" / "true" / "yes" / "on" (case-insensitive).
func truthy(v string) bool {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "1", "true", "yes", "on":
		return true
	}
	return false
}
