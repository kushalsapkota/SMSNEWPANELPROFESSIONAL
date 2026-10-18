// Package client is an upstream SMPP ESME session with automatic reconnect.
//
// One Client owns exactly one SMPP session at a time (the dispatcher creates
// several Clients per upstream connection to get several binds). After New,
// the Client connects and binds in the background, and keeps reconnecting
// with exponential backoff until Close:
//
//	c, err := client.New(client.Config{Addr: "smsc:2775", SystemID: "u", Password: "p",
//	    BindType: pdu.BindTransceiver, OnDeliver: handleDLR})
//	resp, err := c.Submit(ctx, sm)   // ErrNotBound while reconnecting
//	st := c.State()                  // for monitoring
//	c.Close()
package client

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"log/slog"
	"math/rand/v2"
	"net"
	"sync"
	"time"

	"smsgw/engine/internal/smpp/pdu"
	"smsgw/engine/internal/smpp/session"
)

// Status is the externally visible connection state. Values match the
// `state` strings of GET /internal/v1/connections/status (CONTRACTS §5).
type Status string

const (
	StatusConnecting Status = "CONNECTING"
	StatusBoundTX    Status = "BOUND_TX"
	StatusBoundRX    Status = "BOUND_RX"
	StatusBoundTRX   Status = "BOUND_TRX"
	StatusDown       Status = "DOWN"
)

// Bound reports whether s is one of the BOUND_* states.
func (s Status) Bound() bool { return s == StatusBoundTX || s == StatusBoundRX || s == StatusBoundTRX }

func boundStatus(t pdu.BindType) Status {
	switch t {
	case pdu.BindReceiver:
		return StatusBoundRX
	case pdu.BindTransceiver:
		return StatusBoundTRX
	}
	return StatusBoundTX
}

// State is a snapshot of the client for monitoring.
type State struct {
	Status       Status
	LastError    string    // last connect/bind/session error, "" if none
	BoundSince   time.Time // zero unless bound
	Since        time.Time // when Status last changed
	Reconnects   uint64    // completed binds after the first
	InFlight     int       // outstanding submit_sm
	SMSCSystemID string    // system_id returned in bind_resp
}

// Errors returned by Client.
var (
	ErrNotBound       = errors.New("smpp client: not bound")
	ErrNotTransmitter = errors.New("smpp client: session is bound as receiver")
	ErrClientClosed   = errors.New("smpp client: closed")
)

// BindError is the connect error when the SMSC rejects the bind.
type BindError struct{ Status pdu.CommandStatus }

func (e *BindError) Error() string { return "smpp client: bind rejected: " + e.Status.String() }

// DeliverFunc handles a deliver_sm (MO message or delivery receipt). Its
// return value becomes the deliver_sm_resp command_status — return ESME_ROK
// once the PDU is safely handled, or e.g. ESME_RX_T_APPN to make the SMSC
// retry later. It runs on a session goroutine; concurrency is bounded by the
// session's inbound limit.
type DeliverFunc func(d *pdu.DeliverSM) pdu.CommandStatus

// Config configures a Client.
type Config struct {
	Addr string      // host:port
	TLS  *tls.Config // nil = plain TCP

	BindType         pdu.BindType // default BindTransceiver
	SystemID         string       // max 15
	Password         string       // max 8
	SystemType       string       // max 12
	InterfaceVersion uint8        // default 0x34
	AddrTON, AddrNPI uint8
	AddressRange     string

	DialTimeout         time.Duration // default 10s
	BindTimeout         time.Duration // default 10s
	WindowSize          int           // max outstanding submit_sm, default 10
	RequestTimeout      time.Duration // submit_sm_resp wait, default 10s
	EnquireLinkInterval time.Duration // default 30s, negative disables
	ReconnectMin        time.Duration // default 1s
	ReconnectMax        time.Duration // default 60s

	OnDeliver     DeliverFunc // nil: deliver_sm acknowledged with ESME_ROK and dropped
	OnStateChange func(State) // called synchronously on every state change; keep it fast
	Logger        *slog.Logger
}

func (c Config) validate() (Config, error) {
	if c.Addr == "" {
		return c, errors.New("smpp client: Addr is required")
	}
	if c.BindType == 0 {
		c.BindType = pdu.BindTransceiver
	}
	if c.BindType < pdu.BindTransmitter || c.BindType > pdu.BindTransceiver {
		return c, fmt.Errorf("smpp client: invalid bind type %v", c.BindType)
	}
	if len(c.SystemID) > pdu.MaxSystemIDLen-1 || len(c.Password) > pdu.MaxPasswordLen-1 || len(c.SystemType) > pdu.MaxSystemTypeLen-1 {
		return c, errors.New("smpp client: system_id (15), password (8) or system_type (12) too long")
	}
	if c.InterfaceVersion == 0 {
		c.InterfaceVersion = pdu.InterfaceVersion34
	}
	if c.DialTimeout <= 0 {
		c.DialTimeout = 10 * time.Second
	}
	if c.BindTimeout <= 0 {
		c.BindTimeout = 10 * time.Second
	}
	if c.ReconnectMin <= 0 {
		c.ReconnectMin = time.Second
	}
	if c.ReconnectMax <= 0 {
		c.ReconnectMax = 60 * time.Second
	}
	if c.ReconnectMax < c.ReconnectMin {
		c.ReconnectMax = c.ReconnectMin
	}
	if c.Logger == nil {
		c.Logger = slog.Default()
	}
	return c, nil
}

// Client is one auto-reconnecting upstream session. Safe for concurrent use.
type Client struct {
	cfg Config
	log *slog.Logger

	mu        sync.Mutex
	sess      *session.Session // non-nil only while bound
	state     State
	changed   chan struct{} // closed and replaced on every state change
	everBound bool

	closing   chan struct{}
	closeOnce sync.Once
	loopDone  chan struct{}
}

// New validates cfg and starts connecting in the background.
func New(cfg Config) (*Client, error) {
	cfg, err := cfg.validate()
	if err != nil {
		return nil, err
	}
	c := &Client{
		cfg:      cfg,
		log:      cfg.Logger.With("smsc", cfg.Addr, "system_id", cfg.SystemID, "bind", cfg.BindType.String()),
		changed:  make(chan struct{}),
		closing:  make(chan struct{}),
		loopDone: make(chan struct{}),
	}
	c.state = State{Status: StatusConnecting, Since: time.Now()}
	go c.run()
	return c, nil
}

// State returns a snapshot for monitoring.
func (c *Client) State() State {
	c.mu.Lock()
	defer c.mu.Unlock()
	st := c.state
	if c.sess != nil {
		st.InFlight = c.sess.InFlight()
	}
	return st
}

// BindType is the configured bind type.
func (c *Client) BindType() pdu.BindType { return c.cfg.BindType }

// InFlight is the number of outstanding submit_sm.
func (c *Client) InFlight() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.sess == nil {
		return 0
	}
	return c.sess.InFlight()
}

// WaitBound blocks until the client is bound, ctx ends, or Close is called.
func (c *Client) WaitBound(ctx context.Context) error {
	for {
		c.mu.Lock()
		bound := c.state.Status.Bound()
		ch := c.changed
		c.mu.Unlock()
		if bound {
			return nil
		}
		select {
		case <-ch:
		case <-ctx.Done():
			return ctx.Err()
		case <-c.closing:
			return ErrClientClosed
		}
	}
}

func (c *Client) setState(mut func(*State)) {
	c.mu.Lock()
	prev := c.state.Status
	mut(&c.state)
	if c.state.Status != prev {
		c.state.Since = time.Now()
	}
	st := c.state
	close(c.changed)
	c.changed = make(chan struct{})
	c.mu.Unlock()
	if c.cfg.OnStateChange != nil {
		c.cfg.OnStateChange(st)
	}
}

// Submit sends a submit_sm and waits for its response, respecting the
// window (it blocks while WindowSize requests are outstanding, bounded by
// ctx). p is not modified (its Header is ignored), so the same PDU may be
// retried on another Client.
//
// Results:
//   - (resp, nil): accepted, resp.MessageID is the SMSC id;
//   - (resp, *pdu.StatusError): the SMSC rejected it with resp.Status;
//   - (nil, ErrNotBound / ErrNotTransmitter): not sent, try another session;
//   - (nil, session.ErrTimeout / session.ErrClosed / ctx error): outcome unknown.
func (c *Client) Submit(ctx context.Context, p *pdu.SubmitSM) (*pdu.SubmitSMResp, error) {
	c.mu.Lock()
	sess := c.sess
	c.mu.Unlock()
	if sess == nil {
		return nil, ErrNotBound
	}
	if !c.cfg.BindType.CanTransmit() {
		return nil, ErrNotTransmitter
	}
	resp, err := sess.Request(ctx, p)
	if err != nil {
		return nil, err
	}
	r := resp.(*pdu.SubmitSMResp) // type is guaranteed by session.Request
	if r.Status != pdu.ESME_ROK {
		return r, &pdu.StatusError{Command: pdu.CmdSubmitSMResp, Status: r.Status}
	}
	return r, nil
}

// Close stops reconnecting, unbinds gracefully (bounded by 2s) and waits for
// the background loop to exit. Safe to call more than once.
func (c *Client) Close() error {
	c.closeOnce.Do(func() { close(c.closing) })
	<-c.loopDone
	return nil
}

func (c *Client) run() {
	defer close(c.loopDone)
	backoff := c.cfg.ReconnectMin
	for {
		select {
		case <-c.closing:
			c.setState(func(s *State) {
				s.Status = StatusDown
				s.LastError = ErrClientClosed.Error()
				s.BoundSince = time.Time{}
			})
			return
		default:
		}
		c.setState(func(s *State) { s.Status = StatusConnecting })
		sess, smscID, err := c.connect()
		if err != nil {
			c.log.Warn("smpp client: connect failed", "err", err, "retry_in", backoff)
			c.setState(func(s *State) { s.Status = StatusDown; s.LastError = err.Error(); s.BoundSince = time.Time{} })
			if !c.sleep(backoff) {
				continue // closing; loop top handles it
			}
			backoff = nextBackoff(backoff, c.cfg.ReconnectMax)
			continue
		}
		backoff = c.cfg.ReconnectMin
		now := time.Now()
		c.mu.Lock()
		c.sess = sess
		reconnect := c.everBound
		c.everBound = true
		c.mu.Unlock()
		c.log.Info("smpp client: bound", "smsc_system_id", smscID)
		c.setState(func(s *State) {
			s.Status = boundStatus(c.cfg.BindType)
			s.BoundSince = now
			s.LastError = ""
			s.SMSCSystemID = smscID
			if reconnect {
				s.Reconnects++
			}
		})

		var reason error
		select {
		case <-sess.Done():
			reason = sess.Err()
		case <-c.closing:
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			_ = sess.Unbind(ctx)
			cancel()
			reason = ErrClientClosed
		}
		c.mu.Lock()
		c.sess = nil
		c.mu.Unlock()
		msg := ""
		if reason != nil {
			msg = reason.Error()
		}
		c.log.Warn("smpp client: session ended", "err", msg)
		c.setState(func(s *State) { s.Status = StatusDown; s.LastError = msg; s.BoundSince = time.Time{} })
		if reason == ErrClientClosed {
			return
		}
		// brief pause before reconnecting so a flapping SMSC isn't hammered
		c.sleep(jitter(c.cfg.ReconnectMin))
	}
}

// sleep waits d or until closing; returns false if closing.
func (c *Client) sleep(d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-t.C:
		return true
	case <-c.closing:
		return false
	}
}

func nextBackoff(cur, max time.Duration) time.Duration {
	n := cur * 2
	if n > max || n <= 0 {
		n = max
	}
	return jitter(n)
}

// jitter returns d ±20%.
func jitter(d time.Duration) time.Duration {
	if d <= 0 {
		return d
	}
	f := 0.8 + 0.4*rand.Float64()
	return time.Duration(float64(d) * f)
}

func (c *Client) connect() (*session.Session, string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), c.cfg.DialTimeout)
	defer cancel()
	go func() {
		select {
		case <-c.closing:
			cancel()
		case <-ctx.Done():
		}
	}()
	d := &net.Dialer{KeepAlive: 30 * time.Second}
	var conn net.Conn
	var err error
	if c.cfg.TLS != nil {
		td := &tls.Dialer{NetDialer: d, Config: c.cfg.TLS}
		conn, err = td.DialContext(ctx, "tcp", c.cfg.Addr)
	} else {
		conn, err = d.DialContext(ctx, "tcp", c.cfg.Addr)
	}
	if err != nil {
		return nil, "", fmt.Errorf("dial: %w", err)
	}
	sess := session.New(conn, session.Config{
		WindowSize:          c.cfg.WindowSize,
		RequestTimeout:      c.cfg.RequestTimeout,
		EnquireLinkInterval: c.cfg.EnquireLinkInterval,
		Handler:             c.handle,
		Logger:              c.cfg.Logger,
	})
	sess.Start()
	bctx, bcancel := context.WithTimeout(context.Background(), c.cfg.BindTimeout)
	defer bcancel()
	resp, err := sess.Request(bctx, &pdu.Bind{
		BindType:         c.cfg.BindType,
		SystemID:         c.cfg.SystemID,
		Password:         c.cfg.Password,
		SystemType:       c.cfg.SystemType,
		InterfaceVersion: c.cfg.InterfaceVersion,
		AddrTON:          c.cfg.AddrTON,
		AddrNPI:          c.cfg.AddrNPI,
		AddressRange:     c.cfg.AddressRange,
	})
	if err != nil {
		sess.Close()
		var se *pdu.StatusError
		if errors.As(err, &se) {
			return nil, "", &BindError{Status: se.Status}
		}
		return nil, "", fmt.Errorf("bind: %w", err)
	}
	br := resp.(*pdu.BindResp)
	if br.Status != pdu.ESME_ROK {
		sess.Close()
		return nil, "", &BindError{Status: br.Status}
	}
	return sess, br.SystemID, nil
}

func (c *Client) handle(s *session.Session, req pdu.PDU) {
	switch p := req.(type) {
	case *pdu.DeliverSM:
		if !c.cfg.BindType.CanReceive() {
			_ = s.Respond(pdu.NewResponse(req, pdu.ESME_RINVBNDSTS))
			return
		}
		st := pdu.ESME_ROK
		if c.cfg.OnDeliver != nil {
			st = c.safeDeliver(p)
		}
		_ = s.Respond(pdu.NewResponse(req, st))
	case *pdu.DataSM:
		// Not used by our upstreams; refuse explicitly so the SMSC falls back.
		_ = s.Respond(pdu.NewResponse(req, pdu.ESME_RINVCMDID))
	default:
		_ = s.Respond(pdu.NewResponse(req, pdu.ESME_RINVCMDID))
	}
}

func (c *Client) safeDeliver(p *pdu.DeliverSM) (st pdu.CommandStatus) {
	defer func() {
		if r := recover(); r != nil {
			c.log.Error("smpp client: OnDeliver panicked", "panic", r)
			st = pdu.ESME_RX_T_APPN
		}
	}()
	return c.cfg.OnDeliver(p)
}
