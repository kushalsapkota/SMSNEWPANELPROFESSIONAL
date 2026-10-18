// Package dispatch moves accepted messages from the per-route Redis streams
// (q:dispatch:<route_id>, consumer group "dispatch") to upstream SMSCs.
//
// The Manager keeps one upConn per upstream_connections row — N client
// sessions (sessions, bind_type, TLS, enquire_link, reconnect backoff from
// the row) sharing a token bucket of max_tps — and reacts to config reloads
// (store subscription): added connections are bound, changed ones are
// rebound (after their in-flight submits drain), removed ones unbound.
//
// For every message the connection is chosen per CONTRACTS §9: lowest
// route priority with a bound session, weighted random within a priority.
// What happens after a submit_sm depends on what its result proves:
//
//   - explicit rejection (error status, generic_nack) or nothing written
//     (no bound session, shutdown before the write): the next connection is
//     tried (at most MaxFailover failovers), after which the message is
//     FAILED and refunded;
//   - ESME_RTHROTTLED / ESME_RMSGQFUL (SMPP flow control): the same PDU is
//     resubmitted on the same connection with backoff while the
//     connection's rate is halved for a cool-down — no failover, no refund
//     (for up to ThrottleRetry, then it counts as a rejection);
//   - unknown outcome (submit_sm_resp timeout, session lost after the
//     write): the SMSC may have accepted it, so it is NOT resent anywhere and
//     NOT refunded; such parts are recorded with status UNKNOWN.
//
// Multipart messages are sent per the connection's multipart_mode (UDH,
// SAR or message_payload). Each part's dlrmap entry is written as soon as
// its submit_sm_resp arrives (a receipt may beat the remaining parts); parts
// that share one SMSC id get a single entry listing all of them.
//
// Stream entries are acknowledged (XACK + XDEL) only once the message has
// been handled; entries left pending by a crashed instance are reclaimed
// with XAUTOCLAIM after ClaimIdle. A message already submitted (msg state
// has submitted_ms) — or whose submission had started (submitting_ms) — is
// never sent twice by a reclaim.
package dispatch

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"

	"smsgw/engine/internal/cdr"
	"smsgw/engine/internal/httpadapter"
	"smsgw/engine/internal/metrics"
	"smsgw/engine/internal/pipeline"
	"smsgw/engine/internal/routing"
	"smsgw/engine/internal/smpp/pdu"
	"smsgw/engine/internal/smpp/session"
	"smsgw/engine/internal/store"
)

// ConfigSource provides the configuration snapshot and connection change
// notifications. Use StoreSource to adapt a *store.Store.
type ConfigSource interface {
	Current() *store.Snapshot
	// Subscribe returns a channel of connection diffs and a function that
	// ends the subscription.
	Subscribe() (<-chan store.ConnDiff, func())
}

type storeSource struct{ s *store.Store }

func (a storeSource) Current() *store.Snapshot { return a.s.Current() }

func (a storeSource) Subscribe() (<-chan store.ConnDiff, func()) {
	sub := a.s.Subscribe()
	return sub.C, sub.Close
}

// StoreSource adapts a *store.Store to ConfigSource.
func StoreSource(s *store.Store) ConfigSource { return storeSource{s} }

// Finalizer records message outcomes decided by the dispatcher (implemented
// by the DLR processor, which also forwards them to the client).
type Finalizer interface {
	// MessageFailed: nothing was accepted upstream. Marks the message
	// FAILED (CDR, msg state) and notifies the client.
	MessageFailed(ctx context.Context, job *pipeline.DispatchJob, errorCode string, refunded bool) error
	// PartsFailed: some parts of a multipart message were rejected
	// upstream; they count as failed parts in the final DLR aggregation.
	PartsFailed(ctx context.Context, job *pipeline.DispatchJob, parts []int, errorCode string) error
	// PartsUnknown: the outcome of these parts is unknown (submit_sm_resp
	// timeout / session lost after the write); they count as UNKNOWN parts
	// in the final DLR aggregation (no refund: the SMSC may have them).
	PartsUnknown(ctx context.Context, job *pipeline.DispatchJob, parts []int, errorCode string) error
}

// Options tune a Manager.
type Options struct {
	InstanceID      string        // consumer name (required for multi-instance correctness)
	Batch           int           // max entries per XREADGROUP; default 100
	Block           time.Duration // XREADGROUP block; default 1s
	MaxFailover     int           // failovers after the first attempt; 0 = default 2, negative = none
	ClaimIdle       time.Duration // XAUTOCLAIM min idle; default 60s
	MsgStateTTL     time.Duration // dlrmap / msg TTL; default 72h
	MaxQueueAge     time.Duration // give up waiting for a bound connection; default 10m
	WorkersPerRoute int           // concurrent messages per route; default 32
	ScanInterval    time.Duration // discovery of orphan streams (SCAN q:dispatch:*); default 10s, negative disables
	DrainTimeout    time.Duration // shutdown: wait for in-flight messages; default 10s
	// ThrottleRetry bounds how long one PDU is resubmitted on the same
	// connection while the SMSC answers ESME_RTHROTTLED / ESME_RMSGQFUL;
	// default 60s. ThrottleBackoff is the first wait (doubling, max 5s);
	// default 200ms.
	ThrottleRetry   time.Duration
	ThrottleBackoff time.Duration
	// Refunder applies (and retries) refunds; default one built from the
	// biller, Redis and the CDR sink.
	Refunder *pipeline.Refunder

	// HTTP connections. HTTPTransport performs provider requests (default
	// httpadapter.NewHTTPTransport). A transient provider failure is
	// retried HTTPRetries times in total (default 3) on the same
	// connection, waiting HTTPRetryBackoff (default 500ms, doubling, max 5s,
	// or the provider's Retry-After up to 10s) within ThrottleRetry.
	HTTPTransport    httpadapter.Transport
	HTTPRetries      int
	HTTPRetryBackoff time.Duration
	// Receipts applies provider delivery statuses (poll / callback DLRs);
	// Pending lists messages to poll (default DBPending(db) when db is set).
	// PollTick is how often due pollers are checked (default 5s);
	// PollInterval overrides every connection's dlr_poll_interval_s (tests).
	Receipts     ReceiptSink
	Pending      PendingFunc
	PollTick     time.Duration
	PollInterval time.Duration
	// PublicBaseURL (PUBLIC_API_BASE_URL) builds the provider DLR callback
	// URL for adapters that take one per request ("" = not sent).
	PublicBaseURL string

	OnDeliver DeliverFunc                         // upstream deliver_sm (receipts)
	TLSConfig func(*store.Connection) *tls.Config // nil: verify against the host name
	Logger    *slog.Logger
	Metrics   *metrics.Engine
}

// Manager owns upstream connections and dispatch consumers.
type Manager struct {
	src    ConfigSource
	rdb    redis.UniversalClient
	biller pipeline.Biller
	db     *pgxpool.Pool
	sink   pipeline.CDRSink
	fin    Finalizer
	opts   Options
	log    *slog.Logger
	m      *metrics.Engine

	mu      sync.RWMutex
	conns   map[string]*upConn
	https   map[string]*httpConn   // HTTP connections
	queues  map[string]*routeQueue // by stream key
	backlog map[string]int64       // route id -> XLEN

	inprocMu sync.Mutex
	inproc   map[string]map[string]struct{} // stream -> entry ids being handled

	stopping   atomic.Bool
	quit       chan struct{}
	workCtx    context.Context
	workCancel context.CancelFunc
	workers    sync.WaitGroup
	running    atomic.Bool
}

type routeQueue struct {
	stream  string
	routeID string
	ch      chan entry
	group   bool // consumer group known to exist
}

type entry struct {
	stream string
	id     string
	values map[string]any
}

// New creates a Manager. fin may be nil (outcomes are then only written to
// the CDR); db may be nil (no ledger refunds when balances are evicted).
func New(src ConfigSource, rdb redis.UniversalClient, biller pipeline.Biller, db *pgxpool.Pool, sink pipeline.CDRSink, fin Finalizer, o Options) *Manager {
	if o.InstanceID == "" {
		o.InstanceID = "engine"
	}
	if o.Batch <= 0 {
		o.Batch = 100
	}
	if o.Block <= 0 {
		o.Block = time.Second
	}
	switch {
	case o.MaxFailover == 0:
		o.MaxFailover = 2
	case o.MaxFailover < 0:
		o.MaxFailover = 0
	}
	if o.ClaimIdle <= 0 {
		o.ClaimIdle = 60 * time.Second
	}
	if o.MsgStateTTL <= 0 {
		o.MsgStateTTL = 72 * time.Hour
	}
	if o.MaxQueueAge <= 0 {
		o.MaxQueueAge = 10 * time.Minute
	}
	if o.WorkersPerRoute <= 0 {
		o.WorkersPerRoute = 32
	}
	if o.ScanInterval == 0 {
		o.ScanInterval = 10 * time.Second
	}
	if o.DrainTimeout <= 0 {
		o.DrainTimeout = 10 * time.Second
	}
	if o.ThrottleRetry <= 0 {
		o.ThrottleRetry = 60 * time.Second
	}
	if o.ThrottleBackoff <= 0 {
		o.ThrottleBackoff = 200 * time.Millisecond
	}
	if o.HTTPTransport == nil {
		o.HTTPTransport = httpadapter.NewHTTPTransport(nil)
	}
	if o.HTTPRetries <= 0 {
		o.HTTPRetries = 3
	}
	if o.HTTPRetryBackoff <= 0 {
		o.HTTPRetryBackoff = 500 * time.Millisecond
	}
	if o.PollTick <= 0 {
		o.PollTick = 5 * time.Second
	}
	if o.Pending == nil && db != nil {
		o.Pending = DBPending(db)
	}
	if o.Logger == nil {
		o.Logger = slog.Default()
	}
	if o.Metrics == nil {
		o.Metrics = metrics.NewEngine(metrics.NewRegistry())
	}
	if o.Refunder == nil {
		o.Refunder = pipeline.NewRefunder(biller, rdb, sink, pipeline.RefunderOptions{Logger: o.Logger, Metrics: o.Metrics})
	}
	m := &Manager{
		src: src, rdb: rdb, biller: biller, db: db, sink: sink, fin: fin, opts: o,
		log: o.Logger.With("component", "dispatch"), m: o.Metrics,
		conns: map[string]*upConn{}, https: map[string]*httpConn{}, queues: map[string]*routeQueue{}, backlog: map[string]int64{},
		inproc: map[string]map[string]struct{}{}, quit: make(chan struct{}),
	}
	m.workCtx, m.workCancel = context.WithCancel(context.Background())
	return m
}

// Run binds upstream connections and consumes the dispatch streams until ctx
// is cancelled, then drains in-flight messages (≤ DrainTimeout) and unbinds.
func (m *Manager) Run(ctx context.Context) {
	if !m.running.CompareAndSwap(false, true) {
		return
	}
	diffs, unsubscribe := m.src.Subscribe()
	defer unsubscribe()
	if snap := m.src.Current(); snap != nil {
		m.reconcile(snap)
	}

	var bg sync.WaitGroup
	readCtx, stopRead := context.WithCancel(ctx)
	defer stopRead()
	bg.Add(5)
	go func() { defer bg.Done(); m.watchConfig(readCtx, diffs) }()
	go func() { defer bg.Done(); m.pollLoop(readCtx) }()
	go func() { defer bg.Done(); m.readLoop(readCtx) }()
	go func() { defer bg.Done(); m.claimLoop(readCtx) }()
	go func() { defer bg.Done(); m.backlogLoop(readCtx) }()

	<-ctx.Done()
	m.stopping.Store(true)
	stopRead()
	bg.Wait()
	close(m.quit)

	done := make(chan struct{})
	go func() { m.workers.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(m.opts.DrainTimeout):
		m.log.Warn("dispatch drain timed out; aborting in-flight submits")
		m.workCancel()
		<-done
	}
	m.workCancel()

	m.mu.Lock()
	conns := m.conns
	m.conns = map[string]*upConn{}
	m.mu.Unlock()
	var wg sync.WaitGroup
	for _, u := range conns {
		wg.Add(1)
		go func(u *upConn) { defer wg.Done(); u.close() }(u)
	}
	wg.Wait()
}

// --- connection lifecycle ----------------------------------------------------

func (m *Manager) conn(id string) *upConn {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.conns[id]
}

// reconcile makes the running connections match snap (startup / full resync).
func (m *Manager) reconcile(snap *store.Snapshot) {
	m.reconcileHTTP(snap)
	want := map[string]*store.Connection{}
	for _, c := range snap.Connections() {
		if !c.IsHTTP() {
			want[c.ID] = c
		}
	}
	m.mu.Lock()
	var stale []*upConn
	for id, u := range m.conns {
		c, ok := want[id]
		if !ok || !u.cfg.SessionConfigEqual(c) {
			stale = append(stale, u)
			delete(m.conns, id)
			continue
		}
		u.setMaxTPS(c.MaxTPS) // non-session fields apply in place
	}
	m.mu.Unlock()
	for _, u := range stale {
		go u.drainAndClose(u.cfg.SubmitTimeout + time.Second)
	}
	for id, c := range want {
		if m.conn(id) == nil {
			m.start(c)
		}
	}
}

func (m *Manager) start(c *store.Connection) {
	u, err := newUpConn(c, m.opts.OnDeliver, m.opts.TLSConfig, m.log)
	if err != nil {
		m.log.Error("cannot start upstream connection", "connection_id", c.ID, "err", err)
		return
	}
	m.mu.Lock()
	if m.stopping.Load() {
		m.mu.Unlock()
		u.close()
		return
	}
	old := m.conns[c.ID]
	m.conns[c.ID] = u
	m.mu.Unlock()
	if old != nil {
		go old.drainAndClose(old.cfg.SubmitTimeout + time.Second)
	}
	if c.Enabled && c.PasswordErr == nil {
		m.log.Info("upstream connection started", "connection_id", c.ID, "name", c.Name,
			"addr", fmt.Sprintf("%s:%d", c.Host, c.Port), "sessions", c.Sessions, "bind", c.BindType, "tls", c.UseTLS)
	}
}

func (m *Manager) watchConfig(ctx context.Context, diffs <-chan store.ConnDiff) {
	for {
		select {
		case <-ctx.Done():
			return
		case d := <-diffs:
			if d.New == nil {
				continue
			}
			for _, id := range d.Removed {
				m.mu.Lock()
				u := m.conns[id]
				delete(m.conns, id)
				m.mu.Unlock()
				if u != nil {
					m.log.Info("upstream connection removed", "connection_id", id)
					go u.drainAndClose(u.cfg.SubmitTimeout + time.Second)
				}
			}
			for _, id := range append(append([]string(nil), d.Added...), d.Updated...) {
				c := d.New.Connection(id)
				if c == nil || c.IsHTTP() {
					continue // HTTP connections: applied by reconcile, nothing to bind
				}
				if u := m.conn(id); u != nil && u.cfg.SessionConfigEqual(c) {
					// Only per-message fields or max_tps changed: no rebind.
					u.setMaxTPS(c.MaxTPS)
					continue
				}
				m.log.Info("upstream connection (re)configured", "connection_id", id)
				m.start(c)
			}
			// A merged diff can be empty while state still drifted; resync.
			m.reconcile(m.src.Current())
		}
	}
}

// --- stream consumption ------------------------------------------------------

func (m *Manager) queue(stream, routeID string) *routeQueue {
	m.mu.Lock()
	defer m.mu.Unlock()
	if q := m.queues[stream]; q != nil {
		return q
	}
	q := &routeQueue{stream: stream, routeID: routeID, ch: make(chan entry, m.opts.Batch)}
	m.queues[stream] = q
	for i := 0; i < m.opts.WorkersPerRoute; i++ {
		m.workers.Add(1)
		go m.worker(q)
	}
	return q
}

// syncStreams registers a queue for every route in the snapshot plus every
// existing q:dispatch:* stream (orphans of deleted routes are drained so
// their messages are failed and refunded).
func (m *Manager) syncStreams(ctx context.Context, scan bool) {
	if snap := m.src.Current(); snap != nil {
		for _, r := range snap.Routes() {
			m.queue(pipeline.DispatchStream(r.ID), r.ID)
		}
	}
	if !scan {
		return
	}
	var cursor uint64
	for {
		keys, next, err := m.rdb.Scan(ctx, cursor, pipeline.DispatchStreamPrefix+"*", 500).Result()
		if err != nil {
			if ctx.Err() == nil {
				m.log.Warn("scan dispatch streams failed", "err", err)
			}
			return
		}
		for _, k := range keys {
			m.queue(k, strings.TrimPrefix(k, pipeline.DispatchStreamPrefix))
		}
		if cursor = next; cursor == 0 {
			return
		}
	}
}

func (m *Manager) ensureGroup(ctx context.Context, q *routeQueue) bool {
	if q.group {
		return true
	}
	err := m.rdb.XGroupCreateMkStream(ctx, q.stream, pipeline.DispatchGroup, "0").Err()
	if err != nil && !strings.Contains(err.Error(), "BUSYGROUP") {
		if ctx.Err() == nil {
			m.log.Warn("create consumer group failed", "stream", q.stream, "err", err)
		}
		return false
	}
	q.group = true
	return true
}

func (m *Manager) readLoop(ctx context.Context) {
	lastScan := time.Time{}
	for ctx.Err() == nil {
		scan := m.opts.ScanInterval > 0 && time.Since(lastScan) >= m.opts.ScanInterval
		if scan {
			lastScan = time.Now()
		}
		m.syncStreams(ctx, scan)

		m.mu.RLock()
		qs := make([]*routeQueue, 0, len(m.queues))
		for _, q := range m.queues {
			qs = append(qs, q)
		}
		m.mu.RUnlock()
		sort.Slice(qs, func(i, j int) bool { return qs[i].stream < qs[j].stream })

		count := m.opts.Batch
		var keys []string
		byStream := map[string]*routeQueue{}
		for _, q := range qs {
			free := cap(q.ch) - len(q.ch)
			if free <= 0 || !m.ensureGroup(ctx, q) {
				continue
			}
			count = min(count, free)
			keys = append(keys, q.stream)
			byStream[q.stream] = q
		}
		if len(keys) == 0 {
			sleepCtx(ctx, 50*time.Millisecond)
			continue
		}
		streams := make([]string, 0, 2*len(keys))
		streams = append(streams, keys...)
		for range keys {
			streams = append(streams, ">")
		}
		res, err := m.rdb.XReadGroup(ctx, &redis.XReadGroupArgs{
			Group: pipeline.DispatchGroup, Consumer: m.opts.InstanceID, Streams: streams,
			Count: int64(count), Block: m.opts.Block,
		}).Result()
		if err != nil {
			if errors.Is(err, redis.Nil) || ctx.Err() != nil {
				continue
			}
			if strings.Contains(err.Error(), "NOGROUP") {
				m.mu.Lock()
				for _, q := range m.queues {
					q.group = false
				}
				m.mu.Unlock()
				continue
			}
			m.log.Warn("XREADGROUP failed", "err", err)
			sleepCtx(ctx, 500*time.Millisecond)
			continue
		}
		for _, s := range res {
			q := byStream[s.Stream]
			if q == nil {
				continue
			}
			for _, msg := range s.Messages {
				if !m.claimInproc(s.Stream, msg.ID) {
					continue
				}
				q.ch <- entry{stream: s.Stream, id: msg.ID, values: msg.Values}
			}
		}
	}
}

func sleepCtx(ctx context.Context, d time.Duration) {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-t.C:
	case <-ctx.Done():
	}
}

// claimInproc marks an entry as being handled here; false if it already is.
func (m *Manager) claimInproc(stream, id string) bool {
	m.inprocMu.Lock()
	defer m.inprocMu.Unlock()
	s := m.inproc[stream]
	if s == nil {
		s = map[string]struct{}{}
		m.inproc[stream] = s
	}
	if _, dup := s[id]; dup {
		return false
	}
	s[id] = struct{}{}
	return true
}

func (m *Manager) releaseInproc(stream, id string) {
	m.inprocMu.Lock()
	defer m.inprocMu.Unlock()
	if s := m.inproc[stream]; s != nil {
		delete(s, id)
		if len(s) == 0 {
			delete(m.inproc, stream)
		}
	}
}

// claimLoop reclaims entries other consumers left pending for ClaimIdle
// (crashed instance) and keeps entries this instance is still handling
// fresh (XCLAIM JUSTID resets their idle time) so nobody else claims them.
func (m *Manager) claimLoop(ctx context.Context) {
	every := m.opts.ClaimIdle / 3
	if every < 100*time.Millisecond {
		every = 100 * time.Millisecond
	}
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		m.heartbeat(ctx)
		m.mu.RLock()
		qs := make([]*routeQueue, 0, len(m.queues))
		for _, q := range m.queues {
			qs = append(qs, q)
		}
		m.mu.RUnlock()
		for _, q := range qs {
			if !q.group {
				continue
			}
			start := "0-0"
			for ctx.Err() == nil {
				free := cap(q.ch) - len(q.ch)
				if free <= 0 {
					break
				}
				msgs, next, err := m.rdb.XAutoClaim(ctx, &redis.XAutoClaimArgs{
					Stream: q.stream, Group: pipeline.DispatchGroup, Consumer: m.opts.InstanceID,
					MinIdle: m.opts.ClaimIdle, Start: start, Count: int64(free),
				}).Result()
				if err != nil {
					if ctx.Err() == nil && !errors.Is(err, redis.Nil) && !strings.Contains(err.Error(), "NOGROUP") {
						m.log.Warn("XAUTOCLAIM failed", "stream", q.stream, "err", err)
					}
					break
				}
				for _, msg := range msgs {
					if !m.claimInproc(q.stream, msg.ID) {
						continue
					}
					m.log.Info("reclaimed stuck dispatch entry", "stream", q.stream, "entry", msg.ID)
					select {
					case q.ch <- entry{stream: q.stream, id: msg.ID, values: msg.Values}:
					case <-ctx.Done():
						m.releaseInproc(q.stream, msg.ID)
						return
					}
				}
				if next == "0-0" || next == "" || len(msgs) == 0 {
					break
				}
				start = next
			}
		}
	}
}

func (m *Manager) heartbeat(ctx context.Context) {
	m.inprocMu.Lock()
	work := map[string][]string{}
	for s, ids := range m.inproc {
		for id := range ids {
			work[s] = append(work[s], id)
		}
	}
	m.inprocMu.Unlock()
	for s, ids := range work {
		if err := m.rdb.XClaimJustID(ctx, &redis.XClaimArgs{
			Stream: s, Group: pipeline.DispatchGroup, Consumer: m.opts.InstanceID, MinIdle: 0, Messages: ids,
		}).Err(); err != nil && ctx.Err() == nil && !errors.Is(err, redis.Nil) {
			m.log.Debug("dispatch heartbeat failed", "stream", s, "err", err)
		}
	}
}

func (m *Manager) backlogLoop(ctx context.Context) {
	t := time.NewTicker(2 * time.Second)
	defer t.Stop()
	for {
		m.mu.RLock()
		qs := make([]*routeQueue, 0, len(m.queues))
		for _, q := range m.queues {
			qs = append(qs, q)
		}
		m.mu.RUnlock()
		if len(qs) > 0 {
			cmds := make([]*redis.IntCmd, len(qs))
			_, err := m.rdb.Pipelined(ctx, func(p redis.Pipeliner) error {
				for i, q := range qs {
					cmds[i] = p.XLen(ctx, q.stream)
				}
				return nil
			})
			if err == nil || errors.Is(err, redis.Nil) {
				bl := make(map[string]int64, len(qs))
				for i, q := range qs {
					bl[q.routeID] = cmds[i].Val()
				}
				m.mu.Lock()
				m.backlog = bl
				m.mu.Unlock()
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

func (m *Manager) worker(q *routeQueue) {
	defer m.workers.Done()
	for {
		select {
		case <-m.quit:
			return
		case e := <-q.ch:
			if m.stopping.Load() {
				// Not started: leave it pending for another instance / restart.
				m.releaseInproc(e.stream, e.id)
				continue
			}
			m.process(e)
		}
	}
}

func (m *Manager) process(e entry) {
	defer m.releaseInproc(e.stream, e.id)
	job, err := pipeline.DecodeJob(e.values)
	if err != nil {
		m.log.Error("dropping malformed dispatch entry", "stream", e.stream, "entry", e.id, "err", err)
		m.ack(e)
		return
	}
	if m.handle(job) {
		m.ack(e)
	}
}

func (m *Manager) ack(e entry) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, err := m.rdb.Pipelined(ctx, func(p redis.Pipeliner) error {
		p.XAck(ctx, e.stream, pipeline.DispatchGroup, e.id)
		p.XDel(ctx, e.stream, e.id)
		return nil
	})
	if err != nil {
		m.log.Warn("XACK failed; entry may be redelivered (dedup by msg state)", "entry", e.id, "err", err)
	}
}

// --- per message -------------------------------------------------------------

type attemptResult struct {
	ids         []string // smsc ids by PDU index ("" = rejected or unknown)
	failed      []int    // PDU indexes rejected
	unknown     []int    // PDU indexes whose outcome is unknown (may have been accepted)
	pdus        int
	errCode     string
	unknownCode string
	abort       bool // shutdown before anything was written: leave pending
	noDLR       bool // HTTP adapter without delivery reports (dlr_stat NODLR)
}

func (r *attemptResult) accepted() int { return r.pdus - len(r.failed) - len(r.unknown) }

// reachedSMSC: at least one PDU was (or may have been) accepted, so the
// message must not be sent again anywhere.
func (r *attemptResult) reachedSMSC() bool {
	return r.pdus > 0 && (r.accepted() > 0 || len(r.unknown) > 0)
}

// handle dispatches one message; false leaves the stream entry pending.
func (m *Manager) handle(job *pipeline.DispatchJob) bool {
	ctx := m.workCtx
	key := pipeline.MsgKey(job.ID)
	if vals, err := m.rdb.HMGet(ctx, key, pipeline.FSubmittedMS, pipeline.FDone, pipeline.FSubmitting, pipeline.FConnection, pipeline.FPDUs).Result(); err == nil {
		if vals[0] != nil || vals[1] != nil {
			m.log.Info("message already handled; skipping redelivered entry", "message_id", job.ID)
			return true
		}
		if vals[2] != nil {
			// A previous attempt (crashed instance) had started writing
			// submit_sm: the SMSC may have the message. Never resend.
			connID, _ := vals[3].(string)
			pdus := job.Parts
			if s, ok := vals[4].(string); ok {
				if n, err := strconv.Atoi(s); err == nil && n > 0 {
					pdus = n
				}
			}
			m.interrupted(job, connID, pdus)
			return true
		}
	} else if ctx.Err() != nil {
		return false
	}
	for {
		snap := m.src.Current()
		if snap == nil {
			return false
		}
		route := snap.Route(job.RouteID)
		if route == nil || !route.Enabled || !route.HasUsableConnection() {
			m.fail(job, "ROUTE_UNAVAILABLE")
			return true
		}
		tried := map[string]bool{}
		attempts := 0
		lastErr := ""
		for attempts <= m.opts.MaxFailover {
			cands := routing.ConnectionCandidates(route, func(c *store.Connection) bool {
				if tried[c.ID] {
					return false
				}
				if c.IsHTTP() {
					return m.httpUsable(c)
				}
				u := m.conn(c.ID)
				return u != nil && u.canTransmit()
			}, nil)
			if len(cands) == 0 {
				break
			}
			c := cands[0]
			tried[c.ID] = true
			if attempts > 0 {
				m.m.DispatchFailover.Inc()
				m.log.Info("failing over", "message_id", job.ID, "to_connection", c.ID, "previous_error", lastErr)
			}
			attempts++
			var r attemptResult
			if c.IsHTTP() {
				h := m.httpConn(c.ID)
				if h == nil {
					continue
				}
				r = m.attemptHTTP(ctx, job, c, h)
			} else {
				u := m.conn(c.ID)
				if u == nil {
					continue
				}
				r = m.attempt(ctx, job, c, u)
			}
			if r.abort {
				return false
			}
			if r.reachedSMSC() {
				m.succeed(job, c, r)
				return true
			}
			lastErr = r.errCode
		}
		if attempts > 0 {
			m.fail(job, lastErr)
			return true
		}
		// No connection of the route is bound right now: wait for one.
		if time.Since(job.CreatedAt()) > m.opts.MaxQueueAge {
			m.fail(job, "NO_CONNECTION_AVAILABLE")
			return true
		}
		if m.stopping.Load() {
			return false
		}
		sleepCtx(ctx, 250*time.Millisecond)
		if ctx.Err() != nil {
			return false
		}
	}
}

func errorCode(err error) string {
	var se *pdu.StatusError
	switch {
	case errors.As(err, &se):
		return se.Status.String()
	case isTimeout(err):
		return "SUBMIT_TIMEOUT"
	case errors.Is(err, errNoSession):
		return "NO_SESSION"
	case classify(err) == classUnknown:
		return "SUBMIT_UNKNOWN"
	default:
		return "SUBMIT_ERROR"
	}
}

func (m *Manager) attempt(ctx context.Context, job *pipeline.DispatchJob, c *store.Connection, u *upConn) attemptResult {
	pdus, err := buildPDUs(job, c)
	if err != nil {
		m.log.Error("cannot encode message", "message_id", job.ID, "err", err)
		return attemptResult{errCode: "ENCODING_ERROR"}
	}
	r := attemptResult{ids: make([]string, len(pdus)), pdus: len(pdus)}
	// Before anything can reach the SMSC: the PDU count (receipts may beat
	// the remaining parts) and the crash-recovery marker.
	m.markSubmitting(job, c.ID, len(pdus))
	byID := map[string][]int{}
	for i, sm := range pdus {
		resp, err := m.submitPart(ctx, job, c, u, i, sm)
		switch classify(err) {
		case classAccepted:
			r.ids[i] = resp.MessageID
			m.mapPart(c.ID, job, resp.MessageID, i, byID)
			continue
		case classUnknown:
			code := errorCode(err)
			m.log.Warn("submit_sm outcome unknown; not resending", "message_id", job.ID, "connection_id", c.ID, "part", i, "err", err)
			r.unknown = append(r.unknown, i)
			r.unknownCode = code
			continue
		}
		code := errorCode(err)
		if i == 0 {
			if ctx.Err() != nil {
				// Shutdown before part 0 was written: leave it for a restart.
				m.clearSubmitting(job)
				return attemptResult{abort: true}
			}
			m.log.Warn("submit_sm rejected", "message_id", job.ID, "connection_id", c.ID, "part", i, "err", err)
			// Nothing accepted on this connection: the caller fails over.
			return attemptResult{errCode: code}
		}
		m.log.Warn("submit_sm rejected", "message_id", job.ID, "connection_id", c.ID, "part", i, "err", err)
		r.failed = append(r.failed, i)
		r.errCode = code
	}
	return r
}

// submitPart sends one PDU, resubmitting it on the same connection with
// backoff while the SMSC answers with a flow-control status.
func (m *Manager) submitPart(ctx context.Context, job *pipeline.DispatchJob, c *store.Connection, u *upConn, part int, sm *pdu.SubmitSM) (*pdu.SubmitSMResp, error) {
	deadline := time.Now().Add(m.opts.ThrottleRetry)
	delay := m.opts.ThrottleBackoff
	for {
		resp, err := u.submit(ctx, sm, m.m)
		cls := classify(err)
		if cls == classAccepted {
			u.recovered()
		}
		if cls != classThrottled {
			return resp, err
		}
		u.throttled()
		if time.Now().Add(delay).After(deadline) {
			m.log.Warn("upstream kept throttling; giving up on this connection", "message_id", job.ID, "connection_id", c.ID, "part", part, "err", err)
			return resp, err
		}
		m.log.Debug("upstream throttled; resubmitting", "message_id", job.ID, "connection_id", c.ID, "part", part, "retry_in", delay)
		sleepCtx(ctx, delay)
		if ctx.Err() != nil {
			return nil, fmt.Errorf("%w: %w", session.ErrNotSent, ctx.Err())
		}
		delay = min(2*delay, 5*time.Second)
	}
}

func (m *Manager) markSubmitting(job *pipeline.DispatchJob, connID string, pdus int) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	key := pipeline.MsgKey(job.ID)
	if _, err := m.rdb.TxPipelined(ctx, func(p redis.Pipeliner) error {
		p.HSet(ctx, key, pipeline.FSubmitting, time.Now().UnixMilli(), pipeline.FConnection, connID, pipeline.FPDUs, pdus)
		p.Expire(ctx, key, m.opts.MsgStateTTL)
		return nil
	}); err != nil {
		m.log.Warn("could not record submission start", "message_id", job.ID, "err", err)
	}
}

func (m *Manager) clearSubmitting(job *pipeline.DispatchJob) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := m.rdb.HDel(ctx, pipeline.MsgKey(job.ID), pipeline.FSubmitting).Err(); err != nil {
		m.log.Warn("could not clear submission marker", "message_id", job.ID, "err", err)
	}
}

// mapPart writes the dlrmap entry of a part as soon as its submit_sm_resp
// arrives. Parts sharing one SMSC id share one entry listing all of them.
func (m *Manager) mapPart(connID string, job *pipeline.DispatchJob, smscID string, part int, byID map[string][]int) {
	id := pdu.NormalizeMessageID(smscID)
	if id == "" {
		return
	}
	byID[id] = append(byID[id], part)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := m.rdb.Set(ctx, pipeline.DLRMapKey(connID, id), pipeline.DLRMapValueParts(job.ID, byID[id], job.CreatedMS), m.opts.MsgStateTTL).Err(); err != nil {
		m.log.Warn("could not record dlrmap entry; retried after the last part", "message_id", job.ID, "part", part, "err", err)
	}
}

// groupIDs maps normalized SMSC ids to the parts that returned them.
func groupIDs(ids []string) (map[string][]int, []string) {
	by := map[string][]int{}
	var order []string
	for i, raw := range ids {
		id := pdu.NormalizeMessageID(raw)
		if id == "" {
			continue
		}
		if _, ok := by[id]; !ok {
			order = append(order, id)
		}
		by[id] = append(by[id], i)
	}
	return by, order
}

func (m *Manager) succeed(job *pipeline.DispatchJob, c *store.Connection, r attemptResult) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	now := time.Now().UTC()
	ttl := m.opts.MsgStateTTL
	key := pipeline.MsgKey(job.ID)
	var smscIDs []string
	for _, id := range r.ids {
		if id != "" {
			smscIDs = append(smscIDs, id)
		}
	}
	byID, order := groupIDs(r.ids)
	_, err := m.rdb.TxPipelined(ctx, func(p redis.Pipeliner) error {
		// Already written part by part; rewritten here in case one of those
		// writes failed.
		for _, id := range order {
			p.Set(ctx, pipeline.DLRMapKey(c.ID, id), pipeline.DLRMapValueParts(job.ID, byID[id], job.CreatedMS), ttl)
		}
		p.HSet(ctx, key, pipeline.FConnection, c.ID, pipeline.FPDUs, r.pdus, pipeline.FSubmittedMS, now.UnixMilli())
		p.Expire(ctx, key, ttl)
		return nil
	})
	if err != nil {
		m.log.Error("could not record submission state; DLRs for this message may not match", "message_id", job.ID, "err", err)
	}
	upd := cdr.Update{ID: job.ID, CreatedAt: job.CreatedAt(), Status: cdr.StatusSubmitted, ConnectionID: c.ID,
		SMSCMsgIDs: smscIDs, SubmittedAt: &now}
	if cost, _, ok := routing.RouteCost(m.src.Current().Connection(c.ID), job.Dest); ok {
		total := cost * int64(job.Parts)
		upd.RouteCostMicros = &total
	}
	if len(r.unknown) > 0 {
		code := r.unknownCode
		upd.ErrorCode = &code
	} else if r.noDLR && len(r.failed) == 0 {
		// No delivery report will ever come: SUBMITTED is final for this
		// message (never failed / refunded by anything later).
		stat := NoDLRStat
		upd.DLRStat = &stat
	}
	switch {
	case len(r.failed) > 0:
		m.m.DispatchTotal.With("partial").Inc()
		// Refund the share of the rejected parts.
		if len(job.Legs) > 0 {
			amounts := make([]int64, len(job.Legs))
			for i, l := range job.Legs {
				amounts[i] = l.Amount * int64(len(r.failed)) / int64(r.pdus)
			}
			client := job.Legs[0].Amount - amounts[0]
			reseller := client
			if len(job.Legs) > 1 {
				reseller = job.Legs[1].Amount - amounts[1]
			}
			later := &cdr.Update{ID: job.ID, CreatedAt: job.CreatedAt(), ClientCostMicros: &client, ResellerCostMicros: &reseller}
			if m.opts.Refunder.Refund(ctx, job.ID, job.Tag, job.Legs, amounts, "partial_submit", later) == pipeline.RefundApplied {
				upd.ClientCostMicros = &client
				upd.ResellerCostMicros = &reseller
			}
		}
	case len(r.unknown) > 0:
		m.m.DispatchTotal.With("unknown").Inc()
	default:
		m.m.DispatchTotal.With("submitted").Inc()
	}
	if err := m.sink.Update(ctx, upd); err != nil {
		m.log.Error("cdr update failed", "message_id", job.ID, "err", err)
	}
	if m.fin == nil {
		return
	}
	if len(r.failed) > 0 {
		if err := m.fin.PartsFailed(ctx, job, r.failed, r.errCode); err != nil {
			m.log.Error("record failed parts", "message_id", job.ID, "err", err)
		}
	}
	if len(r.unknown) > 0 {
		if err := m.fin.PartsUnknown(ctx, job, r.unknown, r.unknownCode); err != nil {
			m.log.Error("record unknown parts", "message_id", job.ID, "err", err)
		}
	}
}

// interrupted finalizes a message whose submission had started on a crashed
// instance: its parts may have reached the SMSC, so it is neither resent nor
// refunded; every part counts as UNKNOWN.
func (m *Manager) interrupted(job *pipeline.DispatchJob, connID string, pdus int) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	m.log.Warn("submission of message was interrupted; not resending (outcome unknown)", "message_id", job.ID, "connection_id", connID)
	m.m.DispatchTotal.With("unknown").Inc()
	code := "SUBMIT_INTERRUPTED"
	now := time.Now().UTC()
	upd := cdr.Update{ID: job.ID, CreatedAt: job.CreatedAt(), Status: cdr.StatusSubmitted, ConnectionID: connID, ErrorCode: &code, SubmittedAt: &now}
	if err := m.sink.Update(ctx, upd); err != nil {
		m.log.Error("cdr update failed", "message_id", job.ID, "err", err)
	}
	if err := m.rdb.HSet(ctx, pipeline.MsgKey(job.ID), pipeline.FPDUs, pdus, pipeline.FSubmittedMS, now.UnixMilli()).Err(); err != nil {
		m.log.Warn("could not record submission state", "message_id", job.ID, "err", err)
	}
	if m.fin == nil {
		return
	}
	parts := make([]int, pdus)
	for i := range parts {
		parts[i] = i
	}
	if err := m.fin.PartsUnknown(ctx, job, parts, code); err != nil {
		m.log.Error("record unknown parts", "message_id", job.ID, "err", err)
	}
}

func (m *Manager) fail(job *pipeline.DispatchJob, code string) {
	if code == "" {
		code = "SUBMIT_FAILED"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	m.m.DispatchTotal.With("failed").Inc()
	m.log.Warn("message failed", "message_id", job.ID, "route_id", job.RouteID, "error_code", code)
	t := true
	// refunded is true only when the money is actually back; a refund that
	// fails transiently is retried and then flips the CDR flag.
	refunded := m.opts.Refunder.Refund(ctx, job.ID, job.Tag, job.Legs, nil, "dispatch_failed",
		&cdr.Update{ID: job.ID, CreatedAt: job.CreatedAt(), Refunded: &t}) == pipeline.RefundApplied
	if m.fin != nil {
		if err := m.fin.MessageFailed(ctx, job, code, refunded); err != nil {
			m.log.Error("record failure", "message_id", job.ID, "err", err)
		}
		return
	}
	upd := cdr.Update{ID: job.ID, CreatedAt: job.CreatedAt(), Status: cdr.StatusFailed, ErrorCode: &code}
	if refunded {
		upd.Refunded = &refunded
	}
	if err := m.sink.Update(ctx, upd); err != nil {
		m.log.Error("cdr update failed", "message_id", job.ID, "err", err)
	}
	_ = m.rdb.HSet(ctx, pipeline.MsgKey(job.ID), pipeline.FDone, 1, pipeline.FStatus, cdr.StatusFailed).Err()
}

// --- status ------------------------------------------------------------------

// Status reports every configured upstream connection, sorted by name.
func (m *Manager) Status() []ConnStatus {
	snap := m.src.Current()
	if snap == nil {
		return []ConnStatus{}
	}
	m.mu.RLock()
	backlog := m.backlog
	m.mu.RUnlock()
	// A route's backlog is attributed to the connections of its first
	// (lowest priority number) usable group: those that will carry it.
	connBacklog := map[string]int64{}
	for _, r := range snap.Routes() {
		n := backlog[r.ID]
		if n == 0 {
			continue
		}
		prio := -1
		for _, rc := range r.Connections {
			if !rc.Usable() {
				continue
			}
			if prio == -1 {
				prio = rc.Priority
			}
			if rc.Priority != prio {
				break
			}
			connBacklog[rc.ConnectionID] += n
		}
	}
	conns := snap.Connections()
	sort.Slice(conns, func(i, j int) bool { return conns[i].Name < conns[j].Name })
	out := make([]ConnStatus, 0, len(conns))
	for _, c := range conns {
		if c.IsHTTP() {
			h := m.httpConn(c.ID)
			if h == nil {
				h = newHTTPConn(c)
			}
			out = append(out, h.status(c, connBacklog[c.ID]))
			continue
		}
		u := m.conn(c.ID)
		if u == nil {
			u = &upConn{id: c.ID, cfg: c, meter: metrics.NewRateMeter(nil)}
		}
		out = append(out, u.status(c.Name, c.Enabled, c.MaxTPS, connBacklog[c.ID]))
	}
	return out
}

// QueueDepth is the total number of entries in all dispatch streams (as of
// the last backlog sample).
func (m *Manager) QueueDepth() int64 {
	m.mu.RLock()
	defer m.mu.RUnlock()
	var n int64
	for _, v := range m.backlog {
		n += v
	}
	return n
}

// ConnectionsUp returns (connections with a bound session or a READY HTTP
// connection, enabled connections).
func (m *Manager) ConnectionsUp() (up, total int) {
	for _, s := range m.Status() {
		if !s.Enabled {
			continue
		}
		total++
		if s.State == "BOUND" || s.State == "READY" {
			up++
		}
	}
	return up, total
}

// String is for debugging.
func (s ConnStatus) String() string {
	return s.Name + ":" + s.State + "/" + strconv.Itoa(len(s.Sessions))
}
