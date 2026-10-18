package dispatch

// HTTP upstream connections (upstream_connections.kind = 'HTTP'): the
// provider API is called through an httpadapter.Adapter. They take part in
// routing exactly like SMPP connections (same candidates, priority/weight,
// token bucket of max_tps, failover); per-connection concurrency is the
// max_concurrency setting (default 10). There is nothing to bind: config
// changes (credentials, settings, adapter) apply to the next request.
//
// One request carries the whole text (providers split it themselves), so a
// message is one "PDU" for the DLR aggregation (pdus = 1) whatever its
// billed part count. Outcomes mirror the SMPP semantics:
//
//   - Accepted: SUBMITTED; the provider id (or our message id when the
//     provider returns none) goes to smsc_msg_ids and dlrmap. Adapters
//     without delivery reports (dlr_mode none) also get dlr_stat 'NODLR'.
//   - Rejected (or a destination the adapter cannot serve): fail over, then
//     FAILED + refund.
//   - Retry (429 / 408 / 5xx / network error before the request was
//     written): retried on the same connection with backoff (HTTPRetries
//     attempts within ThrottleRetry), then treated as a rejection.
//   - Unknown (timeout or connection loss after the request was written,
//     504, unrecognised 2xx body): never resent, no refund; the message
//     ends UNKNOWN like an SMPP submit_sm_resp timeout.

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/time/rate"

	"smsgw/engine/internal/httpadapter"
	"smsgw/engine/internal/metrics"
	"smsgw/engine/internal/pipeline"
	"smsgw/engine/internal/store"
)

// NoDLRStat is message_logs.dlr_stat for messages sent through an adapter
// without delivery reports: the message stays SUBMITTED for good.
const NoDLRStat = "NODLR"

// ReceiptSink applies provider delivery statuses (dlr.Processor).
type ReceiptSink interface {
	// HandleProviderReceipt records a final status (stat DELIVRD, UNDELIV,
	// EXPIRED, REJECTD, UNKNOWN) for providerID on connection connID.
	// matched=false when no message carries that id.
	HandleProviderReceipt(ctx context.Context, connID, providerID, stat, errCode string) (matched bool, err error)
}

// PendingFunc lists messages submitted on an HTTP connection that still
// wait for a delivery status: created after `after` (and within 48h),
// oldest first, at most limit.
type PendingFunc func(ctx context.Context, connID string, after time.Time, limit int) ([]httpadapter.Pending, error)

// ErrConnectionNotFound: no upstream connection with that id / DLR token.
var ErrConnectionNotFound = errors.New("dispatch: connection not found")

// --- per-connection state ----------------------------------------------------

// gate is a semaphore whose size can change at runtime.
type gate struct {
	mu    sync.Mutex
	limit int
	used  int
	wake  chan struct{}
}

func (g *gate) acquire(ctx context.Context) error {
	for {
		g.mu.Lock()
		if g.used < g.limit {
			g.used++
			g.mu.Unlock()
			return nil
		}
		if g.wake == nil {
			g.wake = make(chan struct{})
		}
		w := g.wake
		g.mu.Unlock()
		select {
		case <-w:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}

func (g *gate) broadcastLocked() {
	if g.wake != nil {
		close(g.wake)
		g.wake = nil
	}
}

func (g *gate) release() {
	g.mu.Lock()
	g.used--
	g.broadcastLocked()
	g.mu.Unlock()
}

func (g *gate) setLimit(n int) {
	g.mu.Lock()
	g.limit = max(n, 1)
	g.broadcastLocked()
	g.mu.Unlock()
}

func (g *gate) inUse() int {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.used
}

// httpConn is the runtime state of one HTTP connection.
type httpConn struct {
	id      string
	limiter *rate.Limiter
	gate    *gate
	meter   *metrics.RateMeter

	waiting   atomic.Int64
	submitted atomic.Uint64
	failed    atomic.Uint64

	mu          sync.Mutex
	baseTPS     int
	lastError   string
	lastErrorAt time.Time
	lastOKAt    time.Time

	// DLR polling
	pollRunning atomic.Bool
	nextPoll    time.Time
	pollCursor  time.Time
}

const defaultMaxConcurrency = 10

func newHTTPConn(c *store.Connection) *httpConn {
	h := &httpConn{id: c.ID, limiter: rate.NewLimiter(rate.Limit(max(c.MaxTPS, 1)), bucketBurst(c.MaxTPS)),
		gate: &gate{limit: maxConcurrency(c)}, meter: metrics.NewRateMeter(nil), baseTPS: max(c.MaxTPS, 1)}
	return h
}

func maxConcurrency(c *store.Connection) int {
	n := httpadapter.Settings(c.HTTPSettings).Int("max_concurrency", defaultMaxConcurrency)
	if n < 1 {
		n = defaultMaxConcurrency
	}
	return min(n, 1000)
}

// apply updates max_tps and max_concurrency in place.
func (h *httpConn) apply(c *store.Connection) {
	tps := max(c.MaxTPS, 1)
	h.mu.Lock()
	if h.baseTPS != tps {
		h.baseTPS = tps
		h.limiter.SetLimit(rate.Limit(tps))
		h.limiter.SetBurst(bucketBurst(tps))
	}
	h.mu.Unlock()
	h.gate.setLimit(maxConcurrency(c))
}

func (h *httpConn) noteOK() {
	h.mu.Lock()
	h.lastOKAt = time.Now().UTC()
	h.mu.Unlock()
}

func (h *httpConn) noteError(msg string) {
	h.mu.Lock()
	h.lastError = msg
	h.lastErrorAt = time.Now().UTC()
	h.mu.Unlock()
}

// --- manager plumbing ----------------------------------------------------------

func (m *Manager) httpConn(id string) *httpConn {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.https[id]
}

// reconcileHTTP makes the HTTP connection states match snap.
func (m *Manager) reconcileHTTP(snap *store.Snapshot) {
	m.mu.Lock()
	defer m.mu.Unlock()
	seen := map[string]bool{}
	for _, c := range snap.Connections() {
		if !c.IsHTTP() {
			continue
		}
		seen[c.ID] = true
		if h := m.https[c.ID]; h != nil {
			h.apply(c)
			continue
		}
		m.https[c.ID] = newHTTPConn(c)
		if c.Enabled {
			m.log.Info("http upstream connection ready", "connection_id", c.ID, "name", c.Name, "adapter", c.Adapter)
		}
	}
	for id := range m.https {
		if !seen[id] {
			delete(m.https, id)
		}
	}
}

// adapterConn builds the adapter's view of c.
func (m *Manager) adapterConn(c *store.Connection, a httpadapter.Adapter) *httpadapter.Conn {
	info := a.Info()
	return httpadapter.NewConn(c.ID, &info, c.HTTPCredentials, c.HTTPSettings, c.DLRToken, m.opts.HTTPTransport)
}

// callbackURL is the public provider-DLR URL of c ("" when unknown).
func (m *Manager) callbackURL(c *store.Connection) string {
	if m.opts.PublicBaseURL == "" || c.DLRToken == "" {
		return ""
	}
	return strings.TrimRight(m.opts.PublicBaseURL, "/") + "/v1/provider-dlr/" + c.DLRToken
}

// httpUsable reports whether c can carry traffic now.
func (m *Manager) httpUsable(c *store.Connection) bool {
	return c.Enabled && c.PasswordErr == nil && httpadapter.Get(c.Adapter) != nil && m.httpConn(c.ID) != nil
}

// --- sending -------------------------------------------------------------------

func (m *Manager) attemptHTTP(ctx context.Context, job *pipeline.DispatchJob, c *store.Connection, h *httpConn) attemptResult {
	ad := httpadapter.Get(c.Adapter)
	if ad == nil {
		return attemptResult{errCode: "ADAPTER_UNKNOWN"}
	}
	info := ad.Info()
	if !httpadapter.AcceptsDestination(&info, job.Dest) {
		m.log.Info("destination not served by adapter; failing over", "message_id", job.ID, "connection_id", c.ID, "adapter", c.Adapter)
		return attemptResult{errCode: "DESTINATION_NOT_SUPPORTED"}
	}
	hc := m.adapterConn(c, ad)
	msg := &httpadapter.Message{ID: job.ID, To: job.Dest, Text: job.Text, Source: job.Source, Encoding: job.Encoding,
		Parts: job.Parts, CallbackURL: m.callbackURL(c)}

	h.waiting.Add(1)
	err := h.gate.acquire(ctx)
	h.waiting.Add(-1)
	if err != nil {
		return attemptResult{abort: true}
	}
	defer h.gate.release()
	m.markSubmitting(job, c.ID, 1)

	deadline := time.Now().Add(m.opts.ThrottleRetry)
	delay := m.opts.HTTPRetryBackoff
	for try := 1; ; try++ {
		h.waiting.Add(1)
		err := h.limiter.Wait(ctx)
		h.waiting.Add(-1)
		if err != nil {
			m.clearSubmitting(job)
			return attemptResult{abort: true}
		}
		start := time.Now()
		res := ad.Send(ctx, hc, msg)
		m.observeHTTP(h, res, time.Since(start))
		switch res.Outcome {
		case httpadapter.Accepted:
			id := res.ProviderID()
			if id == "" {
				id = job.ID
			}
			m.mapPart(c.ID, job, id, 0, map[string][]int{})
			return attemptResult{ids: []string{id}, pdus: 1, noDLR: httpadapter.EffectiveDLRMode(ad, hc) == httpadapter.DLRNone}
		case httpadapter.Unknown:
			m.log.Warn("provider call outcome unknown; not resending", "message_id", job.ID, "connection_id", c.ID,
				"adapter", c.Adapter, "error_code", res.ErrorCode, "err", res.Error)
			return attemptResult{ids: []string{""}, pdus: 1, unknown: []int{0}, unknownCode: res.ErrorCode}
		case httpadapter.Rejected:
			m.log.Warn("provider rejected message", "message_id", job.ID, "connection_id", c.ID, "adapter", c.Adapter,
				"error_code", res.ErrorCode, "err", res.Error)
			return attemptResult{errCode: res.ErrorCode}
		}
		// Retry: nothing was accepted.
		if ctx.Err() != nil {
			m.clearSubmitting(job) // shutdown before the request went out
			return attemptResult{abort: true}
		}
		wait := delay
		if res.RetryAfter > 0 {
			wait = min(res.RetryAfter, 10*time.Second)
		}
		if try >= m.opts.HTTPRetries || time.Now().Add(wait).After(deadline) {
			m.log.Warn("provider kept failing; giving up on this connection", "message_id", job.ID, "connection_id", c.ID,
				"adapter", c.Adapter, "error_code", res.ErrorCode, "err", res.Error, "attempts", try)
			return attemptResult{errCode: res.ErrorCode}
		}
		m.log.Debug("provider call failed transiently; retrying", "message_id", job.ID, "connection_id", c.ID,
			"error_code", res.ErrorCode, "retry_in", wait)
		sleepCtx(ctx, wait)
		if ctx.Err() != nil {
			m.clearSubmitting(job)
			return attemptResult{abort: true}
		}
		delay = min(2*delay, 5*time.Second)
	}
}

// observeHTTP updates metrics and the connection's status after a call.
func (m *Manager) observeHTTP(h *httpConn, res httpadapter.SendResult, d time.Duration) {
	m.m.UpstreamLatency.Observe(d.Seconds())
	m.m.TPSOut.Add(1)
	h.meter.Add(1)
	result := "ok"
	switch res.Outcome {
	case httpadapter.Accepted:
		h.submitted.Add(1)
		h.noteOK()
	case httpadapter.Unknown:
		result = "timeout"
		h.failed.Add(1)
		h.noteError(res.ErrorCode + ": " + res.Error)
	default:
		result = "error"
		h.failed.Add(1)
		if !res.RecipientError {
			h.noteError(res.ErrorCode + ": " + res.Error)
		}
	}
	m.m.UpstreamSubmit.With(h.id, result).Inc()
}

// --- status ------------------------------------------------------------------

func (h *httpConn) status(c *store.Connection, backlog int64) ConnStatus {
	kind, adapter := store.KindHTTP, c.Adapter
	st := ConnStatus{
		ConnectionID: c.ID, Name: c.Name, Enabled: c.Enabled, Kind: kind, Adapter: &adapter, Sessions: []SessionStatus{},
		TPSLimit: c.MaxTPS, TPSCurrent: h.meter.Rate(), InFlight: h.gate.inUse(),
		QueueDepth: h.waiting.Load() + backlog, SubmittedTotal: h.submitted.Load(), FailedTotal: h.failed.Load(),
	}
	h.mu.Lock()
	lastErr, lastErrAt, lastOK := h.lastError, h.lastErrorAt, h.lastOKAt
	h.mu.Unlock()
	if !lastOK.IsZero() {
		t := lastOK
		st.LastSuccessAt = &t
	}
	if !lastErrAt.IsZero() {
		e, t := lastErr, lastErrAt
		st.LastError, st.LastErrorAt = &e, &t
	}
	switch {
	case !c.Enabled:
		st.State = "DISABLED"
	case c.PasswordErr != nil:
		st.State = "ERROR"
		e := "credentials cannot be decrypted: " + c.PasswordErr.Error()
		st.LastError = &e
	case httpadapter.Get(c.Adapter) == nil:
		st.State = "ERROR"
		e := fmt.Sprintf("unknown adapter %q", c.Adapter)
		st.LastError = &e
	case !lastErrAt.IsZero() && lastErrAt.After(lastOK):
		st.State = "ERROR"
	default:
		st.State = "READY"
	}
	return st
}

// --- test send / balance / callbacks (internal API) ----------------------------

// TestRequest is the masked request echo of a test send.
type TestRequest struct {
	Method string `json:"method"`
	URL    string `json:"url"`
	Body   string `json:"body"`
}

// TestResult is POST /internal/v1/connections/:id/test.
type TestResult struct {
	OK                bool         `json:"ok"`
	ProviderMessageID *string      `json:"provider_message_id"`
	HTTPStatus        int          `json:"http_status"`
	Request           *TestRequest `json:"request"`
	ResponseBody      string       `json:"response_body"`
	Error             *string      `json:"error"`
	DurationMS        int64        `json:"duration_ms"`
}

// BalanceResult is GET /internal/v1/connections/:id/balance.
type BalanceResult struct {
	Supported bool    `json:"supported"`
	Balance   *string `json:"balance"`
	Raw       string  `json:"raw"`
	Error     *string `json:"error"`
}

func strPtr(s string) *string { return &s }

func firstBytes(s string, n int) string {
	if len(s) <= n {
		return s
	}
	cut := n
	for cut > 0 && (s[cut]&0xC0) == 0x80 {
		cut--
	}
	return s[:cut]
}

// TestSend sends one real message through HTTP connection id, outside
// billing and the CDR (one attempt, no retries, no failover). from is the
// message's sender ("" = none; adapters use their sender setting first).
func (m *Manager) TestSend(ctx context.Context, id, to, text, from string) (*TestResult, error) {
	snap := m.src.Current()
	if snap == nil {
		return nil, ErrConnectionNotFound
	}
	c := snap.Connection(id)
	if c == nil {
		return nil, ErrConnectionNotFound
	}
	fail := func(msg string) (*TestResult, error) { return &TestResult{OK: false, Error: strPtr(msg)}, nil }
	if !c.IsHTTP() {
		return fail("test send is HTTP-only")
	}
	if c.PasswordErr != nil {
		return fail("credentials cannot be decrypted")
	}
	ad := httpadapter.Get(c.Adapter)
	if ad == nil {
		return fail(fmt.Sprintf("unknown adapter %q", c.Adapter))
	}
	info := ad.Info()
	dest := testDestination(&info, to)
	if dest == "" {
		return fail("invalid destination number")
	}
	if !httpadapter.AcceptsDestination(&info, dest) {
		return fail("destination is not served by this adapter (" + strings.Join(info.DestinationCountries, ",") + " only)")
	}
	if strings.TrimSpace(text) == "" {
		return fail("text is required")
	}
	hc := m.adapterConn(c, ad)
	msg := &httpadapter.Message{ID: pipeline.NewMessageID(), To: dest, Text: text, Source: from, Parts: 1,
		CallbackURL: m.callbackURL(c)}
	start := time.Now()
	res := ad.Send(ctx, hc, msg)
	out := &TestResult{OK: res.Outcome == httpadapter.Accepted, HTTPStatus: res.HTTPStatus, DurationMS: time.Since(start).Milliseconds()}
	if h := m.httpConn(c.ID); h != nil {
		switch {
		case res.Outcome == httpadapter.Accepted:
			h.noteOK()
		case !res.RecipientError:
			h.noteError(res.ErrorCode + ": " + res.Error)
		}
	}
	if id := res.ProviderID(); id != "" {
		out.ProviderMessageID = &id
	}
	if !out.OK {
		e := res.Error
		if e == "" {
			e = res.ErrorCode
		}
		if res.Outcome == httpadapter.Unknown {
			e = "outcome unknown (the provider may have sent it): " + e
		}
		out.Error = strPtr(hc.Mask(e))
	}
	if ex := res.Exchange; ex != nil {
		mr := hc.MaskRequest(ex.Request)
		out.Request = &TestRequest{Method: mr.Method, URL: mr.URL, Body: string(mr.Body)}
		if ex.Response != nil {
			out.ResponseBody = firstBytes(hc.Mask(string(ex.Response.Body)), 4096)
		}
	}
	return out, nil
}

// testDestination normalizes a test-send number: a Nepal local 10-digit
// number gets 977 for NP adapters; anything else must be E.164 digits.
func testDestination(info *httpadapter.Info, to string) string {
	var d strings.Builder
	for _, r := range to {
		if r >= '0' && r <= '9' {
			d.WriteRune(r)
		}
	}
	s := d.String()
	if len(s) == 10 && s[0] == '9' {
		for _, cc := range info.DestinationCountries {
			if cc == "NP" {
				return "977" + s
			}
		}
	}
	if len(s) < 6 || len(s) > 15 {
		return ""
	}
	return s
}

// ProviderBalance queries the provider balance of connection id.
func (m *Manager) ProviderBalance(ctx context.Context, id string) (*BalanceResult, error) {
	snap := m.src.Current()
	if snap == nil || snap.Connection(id) == nil {
		return nil, ErrConnectionNotFound
	}
	c := snap.Connection(id)
	ad := httpadapter.Get(c.Adapter)
	if !c.IsHTTP() || ad == nil {
		return &BalanceResult{Supported: false}, nil
	}
	bc, ok := ad.(httpadapter.BalanceChecker)
	if !ok || !ad.Info().SupportsBalance {
		return &BalanceResult{Supported: false}, nil
	}
	if c.PasswordErr != nil {
		return &BalanceResult{Supported: true, Error: strPtr("credentials cannot be decrypted")}, nil
	}
	hc := m.adapterConn(c, ad)
	r := bc.Balance(ctx, hc)
	out := &BalanceResult{Supported: true, Raw: firstBytes(hc.Mask(r.Raw), 1024)}
	if r.Balance != "" {
		out.Balance = &r.Balance
	}
	if r.Error != "" {
		out.Error = strPtr(hc.Mask(r.Error))
	}
	return out, nil
}

// ProviderDLR handles a provider DLR callback for the connection with
// dlrToken and returns how many receipts updated a message.
func (m *Manager) ProviderDLR(ctx context.Context, dlrToken string, cb *httpadapter.Callback) (int, error) {
	snap := m.src.Current()
	if snap == nil {
		return 0, ErrConnectionNotFound
	}
	c := snap.ConnectionByDLRToken(dlrToken)
	if c == nil || !c.IsHTTP() {
		return 0, ErrConnectionNotFound
	}
	ad := httpadapter.Get(c.Adapter)
	if ad == nil {
		return 0, nil
	}
	p, ok := ad.(httpadapter.CallbackParser)
	if !ok {
		m.log.Info("provider callback for an adapter without callback DLRs; ignored", "connection_id", c.ID, "adapter", c.Adapter)
		return 0, nil
	}
	hc := m.adapterConn(c, ad)
	receipts, err := p.ParseCallback(hc, cb)
	if err != nil {
		m.log.Warn("provider DLR callback rejected", "connection_id", c.ID, "adapter", c.Adapter, "err", hc.Mask(err.Error()))
		return 0, err
	}
	return m.applyReceipts(ctx, c, receipts), nil
}

func (m *Manager) applyReceipts(ctx context.Context, c *store.Connection, receipts []httpadapter.Receipt) int {
	if m.opts.Receipts == nil {
		return 0
	}
	n := 0
	for _, r := range receipts {
		if r.Stat == "" || r.ProviderID == "" {
			m.m.DLRReceived.With("intermediate").Inc()
			continue
		}
		matched, err := m.opts.Receipts.HandleProviderReceipt(ctx, c.ID, r.ProviderID, r.Stat, r.Err)
		if err != nil {
			m.log.Warn("provider receipt not recorded", "connection_id", c.ID, "provider_id", r.ProviderID, "err", err)
			continue
		}
		if matched {
			n++
		}
	}
	return n
}

// --- DLR polling -----------------------------------------------------------------

// pollLoop runs the DLR pollers of "poll" adapters: each connection is
// polled every dlr_poll_interval_s (default 60, min 10) by one engine
// instance (Redis lock httpdlr:poll:<connection>).
func (m *Manager) pollLoop(ctx context.Context) {
	if m.opts.Receipts == nil || m.opts.Pending == nil {
		return
	}
	t := time.NewTicker(m.opts.PollTick)
	defer t.Stop()
	var wg sync.WaitGroup
	defer wg.Wait()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		snap := m.src.Current()
		if snap == nil {
			continue
		}
		now := time.Now()
		for _, c := range snap.Connections() {
			if !c.IsHTTP() || c.PasswordErr != nil {
				continue
			}
			ad := httpadapter.Get(c.Adapter)
			if ad == nil {
				continue
			}
			poller, ok := ad.(httpadapter.DLRPoller)
			hc := m.adapterConn(c, ad)
			if !ok || httpadapter.EffectiveDLRMode(ad, hc) != httpadapter.DLRPoll {
				continue
			}
			h := m.httpConn(c.ID)
			if h == nil || now.Before(h.nextPoll) || !h.pollRunning.CompareAndSwap(false, true) {
				continue
			}
			interval := time.Duration(max(hc.Settings.Int("dlr_poll_interval_s", 60), 10)) * time.Second
			if m.opts.PollInterval > 0 {
				interval = m.opts.PollInterval
			}
			h.nextPoll = now.Add(interval)
			wg.Add(1)
			go func(c *store.Connection) {
				defer wg.Done()
				defer h.pollRunning.Store(false)
				m.pollOnce(ctx, c, hc, poller, h, interval)
			}(c)
		}
	}
}

func (m *Manager) pollOnce(ctx context.Context, c *store.Connection, hc *httpadapter.Conn, poller httpadapter.DLRPoller, h *httpConn, interval time.Duration) {
	lockTTL := interval - interval/10
	ok, err := m.rdb.SetNX(ctx, "httpdlr:poll:"+c.ID, m.opts.InstanceID, lockTTL).Result()
	if err != nil || !ok {
		return // another instance polls this round (or Redis is down)
	}
	limit := hc.Settings.Int("dlr_poll_batch", 50)
	if b, isPaged := poller.(interface{ PollPending() int }); isPaged {
		limit = b.PollPending()
	}
	limit = min(max(limit, 1), 5000)
	pctx, cancel := context.WithTimeout(ctx, max(interval, 30*time.Second))
	defer cancel()
	pending, err := m.opts.Pending(pctx, c.ID, h.pollCursor, limit)
	if err != nil {
		m.log.Warn("cannot list messages awaiting provider DLR", "connection_id", c.ID, "err", err)
		return
	}
	// Rotate through the backlog: a full page moves the cursor, a short one
	// starts over next time.
	if len(pending) >= limit && len(pending) > 0 {
		h.pollCursor = pending[len(pending)-1].CreatedAt
	} else {
		h.pollCursor = time.Time{}
	}
	if len(pending) == 0 {
		return
	}
	receipts, err := poller.PollDLR(pctx, hc, pending)
	if err != nil {
		m.log.Warn("provider DLR poll failed", "connection_id", c.ID, "adapter", c.Adapter, "err", hc.Mask(err.Error()))
	}
	if n := m.applyReceipts(pctx, c, receipts); n > 0 {
		m.log.Debug("provider DLR poll", "connection_id", c.ID, "checked", len(pending), "final", n)
	}
}

// DBPending is the default PendingFunc: message_logs rows SUBMITTED on the
// connection in the last 48 hours with no dlr_stat yet, oldest first.
func DBPending(db *pgxpool.Pool) PendingFunc {
	return func(ctx context.Context, connID string, after time.Time, limit int) ([]httpadapter.Pending, error) {
		if after.IsZero() {
			after = time.Unix(0, 0)
		}
		rows, err := db.Query(ctx, `
			SELECT id::text, created_at, smsc_msg_ids FROM message_logs
			 WHERE connection_id = $1 AND status = 'SUBMITTED' AND dlr_stat IS NULL
			   AND created_at > greatest(now() - interval '48 hours', $2::timestamptz)
			   AND smsc_msg_ids[1] IS DISTINCT FROM id::text
			 ORDER BY created_at LIMIT $3`, connID, after, limit)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		var out []httpadapter.Pending
		for rows.Next() {
			var p httpadapter.Pending
			var ids []string
			if err := rows.Scan(&p.MessageID, &p.CreatedAt, &ids); err != nil {
				return nil, err
			}
			if len(ids) > 0 && ids[0] != p.MessageID {
				p.ProviderID = ids[0]
			}
			out = append(out, p)
		}
		return out, rows.Err()
	}
}
