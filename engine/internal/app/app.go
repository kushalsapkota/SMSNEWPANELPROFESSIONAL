// Package app wires every engine component into one process: config
// snapshot, billing (+ balance syncer), rate limiter, CDR writer, submit
// pipeline, dispatcher (upstream SMPP), DLR processor/forwarder, webhook
// queue, the client SMPP server (:2775), the internal HTTP API (:8081) and
// the Prometheus endpoint (:9100); plus graceful shutdown.
//
// Shutdown order: stop accepting (internal HTTP, client SMPP — clients are
// unbound after in-flight submits finish), drain the dispatcher and unbind
// upstream sessions, stop DLR forwarding and webhooks, flush the CDR
// writer, write balances back to Postgres, close pools.
package app

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"

	"smsgw/engine/internal/billing"
	"smsgw/engine/internal/cdr"
	"smsgw/engine/internal/config"
	"smsgw/engine/internal/crypto"
	"smsgw/engine/internal/dispatch"
	"smsgw/engine/internal/dlr"
	"smsgw/engine/internal/internalapi"
	"smsgw/engine/internal/metrics"
	"smsgw/engine/internal/pipeline"
	"smsgw/engine/internal/ratelimit"
	"smsgw/engine/internal/smpp/server"
	"smsgw/engine/internal/store"
	"smsgw/engine/internal/webhook"
)

// Overrides adjust internals that are not environment-configurable; tests
// use them to isolate shared Redis keys and shorten timers.
type Overrides struct {
	InvalidateChannel   string        // default cfg:invalidate
	DLROutStream        string        // default q:dlr-out
	WebhookKeyPrefix    string        // default "wh:"
	BalanceDirtyKey     string        // default bal:dirty
	WebhookBaseBackoff  time.Duration // default 10s
	WebhookPollInterval time.Duration // default 500ms
	DLRRetryIdle        time.Duration // default 30s
	DLRLookupWait       time.Duration // default 3s
	DispatchMaxQueueAge time.Duration // default 10m
	// DispatchScanInterval: orphan dispatch-stream discovery; default 10s,
	// negative disables (tests sharing a Redis DB with other engines).
	DispatchScanInterval time.Duration
	SessionSweep         time.Duration // default 5s
	UpstreamTLS          func(*store.Connection) *tls.Config
}

// App is a running engine.
type App struct {
	cfg  *config.Config
	ov   Overrides
	log  *slog.Logger
	pool *pgxpool.Pool
	rdb  *redis.Client

	Metrics   *metrics.Engine
	Store     *store.Store
	Biller    *billing.Biller
	Pipeline  *pipeline.Pipeline
	CDR       *cdr.Writer
	Dispatch  *dispatch.Manager
	DLR       *dlr.Processor
	Forwarder *dlr.Forwarder
	Webhooks  *webhook.Queue
	SMPP      *server.Server

	syncer     *billing.Syncer
	httpSrv    *http.Server
	metricsSrv *http.Server
	httpLn     net.Listener
	metricsLn  net.Listener
	smppAddr   net.Addr
}

// New connects to Postgres and Redis, loads the configuration snapshot and
// opens every listener. Call Run to start processing.
func New(ctx context.Context, cfg *config.Config, log *slog.Logger, ov Overrides) (*App, error) {
	if log == nil {
		log = slog.Default()
	}
	a := &App{cfg: cfg, ov: ov, log: log}
	ok := false
	defer func() {
		if !ok {
			a.closeResources()
		}
	}()

	pcfg, err := pgxpool.ParseConfig(cfg.DatabaseURL)
	if err != nil {
		return nil, fmt.Errorf("app: DATABASE_URL: %w", err)
	}
	pcfg.MaxConns, pcfg.MinConns = cfg.DBMaxConns, cfg.DBMinConns
	pcfg.ConnConfig.ConnectTimeout = cfg.DBConnTimeout
	if a.pool, err = pgxpool.NewWithConfig(ctx, pcfg); err != nil {
		return nil, fmt.Errorf("app: postgres: %w", err)
	}
	pctx, cancel := context.WithTimeout(ctx, cfg.DBConnTimeout)
	err = a.pool.Ping(pctx)
	cancel()
	if err != nil {
		return nil, fmt.Errorf("app: postgres ping: %w", err)
	}

	ropt, err := redis.ParseURL(cfg.RedisURL)
	if err != nil {
		return nil, fmt.Errorf("app: REDIS_URL: %w", err)
	}
	ropt.DialTimeout, ropt.ReadTimeout, ropt.WriteTimeout = cfg.RedisTimeout, cfg.RedisTimeout, cfg.RedisTimeout
	if cfg.RedisPoolSize > 0 {
		ropt.PoolSize = cfg.RedisPoolSize
	}
	a.rdb = redis.NewClient(ropt)
	rctx, cancel := context.WithTimeout(ctx, cfg.RedisTimeout)
	err = a.rdb.Ping(rctx).Err()
	cancel()
	if err != nil {
		return nil, fmt.Errorf("app: redis ping: %w", err)
	}

	cipher, err := crypto.NewCipher(cfg.AppEncKey)
	if err != nil {
		return nil, fmt.Errorf("app: APP_ENC_KEY: %w", err)
	}

	a.Metrics = metrics.NewEngine(metrics.NewRegistry())
	a.Store = store.New(a.pool, a.rdb, cipher, store.Options{
		ReloadInterval: cfg.ConfigReloadInterval, Debounce: cfg.ConfigDebounce, MaxDebounce: cfg.ConfigMaxDebounce,
		Channel: ov.InvalidateChannel, Logger: log,
	})
	if err := a.Store.Load(ctx); err != nil {
		return nil, fmt.Errorf("app: initial config load: %w", err)
	}

	a.Biller = billing.New(a.rdb, a.pool, billing.Options{TxnTTL: cfg.DebitTxnTTL, CreditIdemTTL: cfg.CreditIdemTTL,
		DirtyKey: ov.BalanceDirtyKey, Logger: log})
	a.syncer = billing.NewSyncer(a.Biller, billing.SyncerOptions{Interval: cfg.BalanceSyncInterval, FullEvery: cfg.BalanceFullSyncEach})
	a.CDR = cdr.New(a.pool, cdr.Options{FlushInterval: cfg.CDRFlushInterval, BatchSize: cfg.CDRBatchSize, Logger: log, Metrics: a.Metrics})
	a.Pipeline = pipeline.New(pipeline.Deps{
		Store: a.Store, Biller: a.Biller, Limiter: ratelimit.New(a.rdb), CDR: a.CDR, Redis: a.rdb, DB: a.pool,
		Metrics: a.Metrics, Logger: log, MsgStateTTL: cfg.MsgStateTTL,
	})
	a.Webhooks = webhook.New(a.rdb, a.pool, a.Store, webhook.Options{
		KeyPrefix: ov.WebhookKeyPrefix, Workers: cfg.WebhookWorkers, Timeout: cfg.WebhookTimeout,
		BaseBackoff: ov.WebhookBaseBackoff, PollInterval: ov.WebhookPollInterval, Logger: log, Metrics: a.Metrics,
	})
	a.DLR = dlr.NewProcessor(a.rdb, a.CDR, a.pool, dlr.Options{Stream: ov.DLROutStream, LookupWait: ov.DLRLookupWait, Logger: log, Metrics: a.Metrics})

	auth := &authenticator{store: a.Store, cache: crypto.NewBindCache(cfg.BindCacheTTL, 0), db: a.pool, log: log.With("component", "smpp-auth"),
		sem: make(chan struct{}, 4), maxSessions: cfg.SMPPMaxSessions}
	a.SMPP, err = server.New(server.Config{
		Authenticator:       auth,
		Handler:             &smppHandler{p: a.Pipeline, log: log.With("component", "smpp-server")},
		SystemID:            cfg.SMPPServerSystemID,
		BindTimeout:         cfg.SMPPBindTimeout,
		WindowSize:          cfg.SMPPDeliverWindow,
		RequestTimeout:      cfg.SMPPDeliverTimeout,
		EnquireLinkInterval: max(cfg.SMPPEnquireTimeout/3, time.Second),
		Logger:              log.With("component", "smpp-server"),
		OnIncomplete: func(m server.IncompleteMessage) {
			log.Warn("client multipart message expired incomplete", "system_id", m.Session.SystemID, "received", m.Received, "total", m.Total)
		},
	})
	if err != nil {
		return nil, err
	}
	auth.sessions = func() int { return len(a.SMPP.Sessions()) }

	maxFailover := cfg.DispatchMaxFailover
	if maxFailover == 0 {
		maxFailover = -1 // explicit "no failover" (0 means default in dispatch.Options)
	}
	a.Dispatch = dispatch.New(dispatch.StoreSource(a.Store), a.rdb, a.Biller, a.pool, a.CDR, a.DLR, dispatch.Options{
		InstanceID: cfg.InstanceID, Batch: cfg.DispatchBatch, Block: cfg.DispatchBlock, MaxFailover: maxFailover,
		ClaimIdle: cfg.DispatchClaimIdle, MsgStateTTL: cfg.MsgStateTTL, MaxQueueAge: ov.DispatchMaxQueueAge, ScanInterval: ov.DispatchScanInterval,
		DrainTimeout: cfg.ShutdownTimeout / 2, OnDeliver: a.DLR.HandleDeliver, TLSConfig: ov.UpstreamTLS,
		Logger: log, Metrics: a.Metrics,
	})
	a.Forwarder = dlr.NewForwarder(a.rdb, a.Store, a.SMPP, a.Webhooks, dlr.ForwarderOptions{
		Stream: ov.DLROutStream, Consumer: cfg.InstanceID, RetryIdle: ov.DLRRetryIdle,
		DeliverTimeout: cfg.SMPPDeliverTimeout, MaxAge: cfg.MsgStateTTL, Logger: log, Metrics: a.Metrics,
	})
	a.registerGauges()

	api := internalapi.New(internalapi.Deps{
		Token: cfg.InternalToken, Pipeline: a.Pipeline, Connections: a.Dispatch, SMPP: a.SMPP, Balances: a.Biller,
		Store: a.Store, DB: a.pool, Redis: a.rdb, Rates: rates{a.Metrics}, MaxBody: cfg.HTTPMaxBodyBytes, Logger: log,
	})
	a.httpSrv = &http.Server{Handler: api, ReadTimeout: cfg.HTTPReadTimeout, ReadHeaderTimeout: 5 * time.Second,
		WriteTimeout: cfg.HTTPWriteTimeout, IdleTimeout: cfg.HTTPIdleTimeout}
	mux := http.NewServeMux()
	mux.Handle("/metrics", a.Metrics.Registry.Handler())
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) { w.Write([]byte("ok\n")) })
	a.metricsSrv = &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second}

	if a.httpLn, err = net.Listen("tcp", cfg.HTTPAddr); err != nil {
		return nil, fmt.Errorf("app: listen %s: %w", cfg.HTTPAddr, err)
	}
	if a.metricsLn, err = net.Listen("tcp", cfg.MetricsAddr); err != nil {
		return nil, fmt.Errorf("app: listen %s: %w", cfg.MetricsAddr, err)
	}
	if a.smppAddr, err = a.SMPP.Listen(cfg.SMPPAddr); err != nil {
		return nil, fmt.Errorf("app: listen %s: %w", cfg.SMPPAddr, err)
	}
	ok = true
	return a, nil
}

type rates struct{ m *metrics.Engine }

func (r rates) TPSIn() float64  { return r.m.TPSIn.Rate() }
func (r rates) TPSOut() float64 { return r.m.TPSOut.Rate() }

func (a *App) registerGauges() {
	reg := a.Metrics.Registry
	reg.GaugeFunc("smsgw_tps_in", "Messages accepted during the last second.", nil, func() []metrics.Sample {
		return []metrics.Sample{{Value: a.Metrics.TPSIn.Rate()}}
	})
	reg.GaugeFunc("smsgw_tps_out", "PDUs submitted upstream during the last second.", nil, func() []metrics.Sample {
		return []metrics.Sample{{Value: a.Metrics.TPSOut.Rate()}}
	})
	reg.GaugeFunc("smsgw_dispatch_queue_depth", "Entries in all dispatch streams.", nil, func() []metrics.Sample {
		return []metrics.Sample{{Value: float64(a.Dispatch.QueueDepth())}}
	})
	reg.GaugeFunc("smsgw_cdr_queue_length", "CDR operations waiting to be written.", nil, func() []metrics.Sample {
		return []metrics.Sample{{Value: float64(a.CDR.QueueLen())}}
	})
	reg.GaugeFunc("smsgw_smpp_client_sessions", "Bound client SMPP sessions.", nil, func() []metrics.Sample {
		return []metrics.Sample{{Value: float64(len(a.SMPP.Sessions()))}}
	})
	reg.GaugeFunc("smsgw_upstream_connection_up", "1 if the upstream connection has a bound session.", []string{"connection", "name"}, func() []metrics.Sample {
		var out []metrics.Sample
		for _, s := range a.Dispatch.Status() {
			v := 0.0
			if s.State == "BOUND" {
				v = 1
			}
			out = append(out, metrics.Sample{LabelValues: []string{s.ConnectionID, s.Name}, Value: v})
		}
		return out
	})
	reg.GaugeFunc("smsgw_upstream_inflight", "Outstanding submit_sm per upstream connection.", []string{"connection"}, func() []metrics.Sample {
		var out []metrics.Sample
		for _, s := range a.Dispatch.Status() {
			out = append(out, metrics.Sample{LabelValues: []string{s.ConnectionID}, Value: float64(s.InFlight)})
		}
		return out
	})
	reg.GaugeFunc("smsgw_config_reloads", "Configuration reloads (ok / failed).", []string{"result"}, func() []metrics.Sample {
		ok, failed, _ := a.Store.Stats()
		return []metrics.Sample{{LabelValues: []string{"ok"}, Value: float64(ok)}, {LabelValues: []string{"failed"}, Value: float64(failed)}}
	})
	reg.GaugeFunc("smsgw_config_version", "Version of the active configuration snapshot.", nil, func() []metrics.Sample {
		if s := a.Store.Current(); s != nil {
			return []metrics.Sample{{Value: float64(s.Version)}}
		}
		return []metrics.Sample{{Value: 0}}
	})
}

// HTTPAddr, SMPPAddr and MetricsAddr are the bound listener addresses.
func (a *App) HTTPAddr() string    { return a.httpLn.Addr().String() }
func (a *App) SMPPAddr() string    { return a.smppAddr.String() }
func (a *App) MetricsAddr() string { return a.metricsLn.Addr().String() }

// Pool and Redis expose the shared clients (tests, tooling).
func (a *App) Pool() *pgxpool.Pool  { return a.pool }
func (a *App) Redis() *redis.Client { return a.rdb }

// Run serves until ctx is cancelled, then shuts down gracefully (bounded by
// ShutdownTimeout). It returns the first fatal listener error, if any.
func (a *App) Run(ctx context.Context) error {
	type comp struct {
		name   string
		cancel context.CancelFunc
		done   chan struct{}
	}
	start := func(name string, fn func(context.Context)) *comp {
		cctx, cancel := context.WithCancel(context.Background())
		c := &comp{name: name, cancel: cancel, done: make(chan struct{})}
		go func() { defer close(c.done); fn(cctx) }()
		return c
	}
	storeC := start("store", a.Store.Run)
	syncC := start("balance-syncer", a.syncer.Run)
	cdrDone := make(chan struct{})
	go func() { defer close(cdrDone); a.CDR.Run(context.Background()) }()
	dispatchC := start("dispatch", a.Dispatch.Run)
	fwdC := start("dlr-forwarder", a.Forwarder.Run)
	whC := start("webhooks", a.Webhooks.Run)
	sweepC := start("session-sweeper", func(ctx context.Context) {
		every := a.ov.SessionSweep
		if every <= 0 {
			every = 5 * time.Second
		}
		t := time.NewTicker(every)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				if snap := a.Store.Current(); snap != nil {
					sweepSessions(snap, a.SMPP, a.log)
				}
			}
		}
	})

	errc := make(chan error, 2)
	go func() {
		if err := a.httpSrv.Serve(a.httpLn); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errc <- fmt.Errorf("internal http: %w", err)
		}
	}()
	go func() {
		if err := a.metricsSrv.Serve(a.metricsLn); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errc <- fmt.Errorf("metrics http: %w", err)
		}
	}()
	a.log.Info("engine started", "http", a.HTTPAddr(), "smpp", a.SMPPAddr(), "metrics", a.MetricsAddr(),
		"instance", a.cfg.InstanceID)

	var runErr error
	select {
	case <-ctx.Done():
	case runErr = <-errc:
		a.log.Error("listener failed; shutting down", "err", runErr)
	}

	a.log.Info("shutting down")
	deadline := time.Now().Add(a.cfg.ShutdownTimeout)
	sctx, cancel := context.WithDeadline(context.Background(), deadline)
	defer cancel()
	stop := func(c *comp) {
		c.cancel()
		select {
		case <-c.done:
		case <-sctx.Done():
			a.log.Warn("component did not stop in time", "component", c.name)
		}
	}

	// 1. Stop intake.
	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); _ = a.httpSrv.Shutdown(sctx) }()
	go func() { defer wg.Done(); _ = a.SMPP.Close() }()
	wg.Wait()
	stop(sweepC)
	// 2. Drain the dispatcher (finishes in-flight submits, unbinds upstream).
	stop(dispatchC)
	// 3. Client notifications.
	stop(fwdC)
	stop(whC)
	// 4. Persist CDRs and balances.
	if err := a.CDR.Close(sctx); err != nil {
		a.log.Error("CDR flush incomplete at shutdown", "err", err)
	}
	select {
	case <-cdrDone:
	case <-sctx.Done():
	}
	stop(syncC) // the syncer performs a final flush on cancel
	stop(storeC)
	_ = a.metricsSrv.Shutdown(sctx)
	a.closeResources()
	a.log.Info("engine stopped")
	return runErr
}

func (a *App) closeResources() {
	if a.httpLn != nil {
		a.httpLn.Close()
	}
	if a.metricsLn != nil {
		a.metricsLn.Close()
	}
	if a.SMPP != nil && a.smppAddr == nil {
		a.SMPP.Close()
	}
	if a.rdb != nil {
		a.rdb.Close()
	}
	if a.pool != nil {
		a.pool.Close()
	}
}
