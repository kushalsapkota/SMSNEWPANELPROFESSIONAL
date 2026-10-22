// Package server is the client-facing SMSC: ESMEs (our CLIENT orgs) bind
// here and submit messages; the gateway pushes delivery receipts back with
// Deliver.
//
// The server handles the SMPP mechanics — bind state, authentication via
// Authenticator, max_binds and per-session TPS limits, reassembly of
// concatenated messages (UDH 8/16-bit and SAR TLVs, plus message_payload),
// text decoding — and calls Handler once per complete logical message.
//
//	srv, _ := server.New(server.Config{Authenticator: auth, Handler: h})
//	_ = srv.Listen(":2775")
//	...
//	srv.DeliverTo(ctx, orgID, systemID, receiptPDU)
//	srv.Kick(orgID)
//	srv.Close()
package server

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	"smsgw/engine/internal/smpp/pdu"
	"smsgw/engine/internal/smpp/session"
)

// BindRequest is what an Authenticator sees.
type BindRequest struct {
	BindType         pdu.BindType
	SystemID         string
	Password         string
	SystemType       string
	InterfaceVersion uint8
	AddrTON, AddrNPI uint8
	AddressRange     string
	RemoteAddr       net.Addr // for IP whitelisting
	// Reason is set by the Authenticator on rejection to a human-readable cause
	// (e.g. "SMPP access is disabled for this account") for the bind-event log.
	Reason string
}

// Identity is the authenticated principal of a session.
type Identity struct {
	OrgID    string
	SystemID string
	// AllowedBindTypes restricts the bind operations; empty allows all.
	AllowedBindTypes []pdu.BindType
	// MaxBinds caps concurrent sessions for SystemID; 0 = unlimited.
	MaxBinds int
	// TPS caps submit_sm/data_sm per second per session (ESME_RTHROTTLED
	// beyond it); 0 = unlimited.
	TPS int
	// Attributes is opaque data for the Handler (e.g. the smpp_accounts row).
	Attributes any
}

func (id *Identity) allows(t pdu.BindType) bool {
	if len(id.AllowedBindTypes) == 0 {
		return true
	}
	for _, a := range id.AllowedBindTypes {
		if a == t {
			return true
		}
	}
	return false
}

// Authenticator decides whether a bind succeeds. Return a non-nil Identity
// and ESME_ROK to accept, or a non-OK status (ESME_RINVPASWD, ESME_RINVSYSID,
// ESME_RBINDFAIL, ...) to reject. ctx is bounded by Config.AuthTimeout.
type Authenticator interface {
	Authenticate(ctx context.Context, req *BindRequest) (*Identity, pdu.CommandStatus)
}

// AuthenticatorFunc adapts a function to Authenticator.
type AuthenticatorFunc func(ctx context.Context, req *BindRequest) (*Identity, pdu.CommandStatus)

// Authenticate implements Authenticator.
func (f AuthenticatorFunc) Authenticate(ctx context.Context, req *BindRequest) (*Identity, pdu.CommandStatus) {
	return f(ctx, req)
}

// Handler processes complete messages.
type Handler interface {
	// NewMessageID returns a fresh unique message id (≤ 64 chars) to give
	// the ESME. It is called once per logical message (or once per part
	// with Config.PerPartMessageIDs) BEFORE HandleMessage, so non-final parts
	// can be acknowledged immediately. It must be fast and must not block.
	NewMessageID() string
	// HandleMessage is called exactly once per complete logical message.
	// Its return value is the command_status of the submit_sm_resp for the
	// final (completing) part; on ESME_ROK the response carries m.ID (or the
	// part's id). ctx is cancelled when the server shuts down.
	HandleMessage(ctx context.Context, m *Message) pdu.CommandStatus
}

// MultipartKind says how a message was concatenated.
type MultipartKind string

const (
	MultipartNone    MultipartKind = ""
	MultipartUDH8    MultipartKind = "UDH8"
	MultipartUDH16   MultipartKind = "UDH16"
	MultipartSAR     MultipartKind = "SAR"
	MultipartPayload MultipartKind = "PAYLOAD" // single PDU carrying message_payload
)

// Message is one complete logical message.
type Message struct {
	// ID is the pre-assigned message id (Handler.NewMessageID) returned to
	// the ESME. PartIDs has one entry per part, in part order; all equal ID
	// unless Config.PerPartMessageIDs is set, in which case each part has its
	// own id and ID is the id of the first part that arrived.
	ID      string
	PartIDs []string

	Session SessionInfo

	ServiceType          string
	SourceAddr           string
	SourceTON            uint8
	SourceNPI            uint8
	DestAddr             string
	DestTON              uint8
	DestNPI              uint8
	ESMClass             uint8 // of the first part, as sent (UDHI bit included)
	ProtocolID           uint8
	PriorityFlag         uint8
	RegisteredDelivery   uint8
	DataCoding           uint8
	ScheduleDeliveryTime string
	ValidityPeriod       string

	// Text is the decoded full text; Payload the concatenated raw user data
	// (UDH removed) it was decoded from.
	Text    string
	Payload []byte

	Parts     int
	Multipart MultipartKind
	// TLVs of the first part (SAR TLVs included when present).
	TLVs pdu.TLVs
	// Command is CmdSubmitSM or CmdDataSM.
	Command    pdu.CommandID
	ReceivedAt time.Time // when the first part arrived
}

// IncompleteMessage is reported when a multipart set expires.
type IncompleteMessage struct {
	ID         string
	PartIDs    []string    // "" for parts never received
	Session    SessionInfo // session of the first received part
	SourceAddr string
	DestAddr   string
	Received   int
	Total      int
	Multipart  MultipartKind
	FirstSeen  time.Time
}

// SessionInfo describes a bound session (for monitoring and the Handler).
type SessionInfo struct {
	ID             string
	OrgID          string
	SystemID       string
	BindType       pdu.BindType
	RemoteAddr     string
	BoundSince     time.Time
	TPSCurrent     float64 // submits during the last full second
	SubmittedTotal uint64  // submit_sm/data_sm PDUs received
	InFlight       int     // outstanding deliver_sm
	Identity       *Identity
}

// Config configures a Server. Authenticator and Handler are required.
type Config struct {
	Authenticator Authenticator
	Handler       Handler

	SystemID    string        // returned in bind_resp; default "SMSGW"
	TLSConfig   *tls.Config   // Listen wraps the listener when set
	BindTimeout time.Duration // close connections not bound within; default 30s
	AuthTimeout time.Duration // Authenticate ctx timeout; default 10s
	// MaxBindFailures closes a connection after this many rejected bind
	// attempts (password guessing on one TCP connection); default 3.
	MaxBindFailures int

	WindowSize            int           // max outstanding deliver_sm per session; default 10
	RequestTimeout        time.Duration // deliver_sm_resp wait; default 10s
	EnquireLinkInterval   time.Duration // default 30s; negative disables
	MaxInboundConcurrency int           // concurrent submit handling per session; default 64

	// ConcatTimeout expires incomplete multipart sets; default 60s.
	ConcatTimeout time.Duration
	// MaxPendingConcat caps incomplete multipart sets per system_id
	// (ESME_RMSGQFUL beyond); default 1000.
	MaxPendingConcat int
	// PerPartMessageIDs gives every part its own id (as real SMSCs do).
	// Default false: one id per logical message, returned for every part.
	PerPartMessageIDs bool
	// ConcatStore (optional) keeps incomplete multipart sets outside the
	// process (e.g. Redis) so parts sent on binds held by different
	// instances join. nil = in-process reassembly.
	ConcatStore ConcatStore

	OnIncomplete func(IncompleteMessage)  // expired multipart sets
	OnBind       func(SessionInfo)        // after a successful bind
	OnUnbind     func(SessionInfo, error) // a bound session ended
	// BindEventLogSize caps the recent bind-event ring buffer (accept/reject/
	// unbind) exposed via Server.Events; 0 = default 2000.
	BindEventLogSize int
	Logger           *slog.Logger
}

func (c Config) withDefaults() (Config, error) {
	if c.Authenticator == nil || c.Handler == nil {
		return c, errors.New("smpp server: Authenticator and Handler are required")
	}
	if c.SystemID == "" {
		c.SystemID = "SMSGW"
	}
	if len(c.SystemID) > pdu.MaxSystemIDLen-1 {
		return c, errors.New("smpp server: SystemID longer than 15")
	}
	if c.BindTimeout <= 0 {
		c.BindTimeout = 30 * time.Second
	}
	if c.AuthTimeout <= 0 {
		c.AuthTimeout = 10 * time.Second
	}
	if c.MaxBindFailures <= 0 {
		c.MaxBindFailures = 3
	}
	if c.ConcatTimeout <= 0 {
		c.ConcatTimeout = 60 * time.Second
	}
	if c.MaxPendingConcat <= 0 {
		c.MaxPendingConcat = 1000
	}
	if c.Logger == nil {
		c.Logger = slog.Default()
	}
	return c, nil
}

// Errors returned by Server.
var (
	ErrServerClosed = errors.New("smpp server: closed")
	ErrNoSession    = errors.New("smpp server: no bound receiver session for system_id")
)

// BindEvent is one entry in the server's recent bind-event log (accepted,
// rejected — with reason — or unbound). Exposed for monitoring.
type BindEvent struct {
	Time       time.Time
	Type       string // "bound", "rejected", "unbound"
	SystemID   string
	OrgID      string
	RemoteAddr string
	BindType   string
	Status     string // SMPP command_status word for a rejection; "" otherwise
	Reason     string
	SessionID  string
}

// bindEventLog is a fixed-size, concurrency-safe ring buffer of BindEvents.
type bindEventLog struct {
	mu   sync.Mutex
	buf  []BindEvent
	next int
	full bool
}

func newBindEventLog(capacity int) *bindEventLog {
	if capacity <= 0 {
		capacity = 2000
	}
	return &bindEventLog{buf: make([]BindEvent, capacity)}
}

func (l *bindEventLog) add(ev BindEvent) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.buf[l.next] = ev
	l.next = (l.next + 1) % len(l.buf)
	if l.next == 0 {
		l.full = true
	}
}

// snapshot returns up to limit events, newest first (0 = all held).
func (l *bindEventLog) snapshot(limit int) []BindEvent {
	l.mu.Lock()
	defer l.mu.Unlock()
	n := l.next
	start := 0
	if l.full {
		n = len(l.buf)
		start = l.next
	}
	out := make([]BindEvent, 0, n)
	for i := n - 1; i >= 0; i-- { // newest first
		out = append(out, l.buf[(start+i)%len(l.buf)])
	}
	if limit > 0 && len(out) > limit {
		out = out[:limit]
	}
	return out
}

// statusReason gives a generic reason when the Authenticator set none.
func statusReason(st pdu.CommandStatus) string {
	switch st {
	case pdu.ESME_RINVSYSID:
		return "unknown system_id"
	case pdu.ESME_RINVPASWD:
		return "invalid password"
	case pdu.ESME_RALYBND:
		return "already bound on this connection"
	case pdu.ESME_RSYSERR:
		return "server error"
	case pdu.ESME_RBINDFAIL:
		return "bind failed"
	default:
		return st.String()
	}
}

// Server is the SMPP SMSC. Safe for concurrent use.
type Server struct {
	cfg Config
	log *slog.Logger

	ctx    context.Context
	cancel context.CancelFunc

	mu        sync.Mutex
	closed    bool
	listeners map[net.Listener]struct{}
	conns     map[*conn]struct{}            // every live connection
	bySystem  map[string]map[*conn]struct{} // bound (or binding-reserved) sessions
	rr        map[string]uint64             // round-robin counters for Deliver

	concat *reassembler
	nextID atomic.Uint64
	wg     sync.WaitGroup
	events *bindEventLog
}

// Events returns the most recent bind events, newest first (0 = all held).
func (s *Server) Events(limit int) []BindEvent { return s.events.snapshot(limit) }

// New validates cfg and creates a Server (not yet listening).
func New(cfg Config) (*Server, error) {
	cfg, err := cfg.withDefaults()
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	s := &Server{
		cfg:       cfg,
		log:       cfg.Logger,
		ctx:       ctx,
		cancel:    cancel,
		listeners: map[net.Listener]struct{}{},
		conns:     map[*conn]struct{}{},
		bySystem:  map[string]map[*conn]struct{}{},
		rr:        map[string]uint64{},
		events:    newBindEventLog(cfg.BindEventLogSize),
	}
	s.concat = newReassembler(s)
	return s, nil
}

// Listen opens addr (wrapping it in TLS if Config.TLSConfig is set) and
// serves in the background. It returns once the listener is open.
func (s *Server) Listen(addr string) (net.Addr, error) {
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return nil, err
	}
	if s.cfg.TLSConfig != nil {
		ln = tls.NewListener(ln, s.cfg.TLSConfig)
	}
	if err := s.track(ln); err != nil {
		ln.Close()
		return nil, err
	}
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		_ = s.serve(ln)
	}()
	return ln.Addr(), nil
}

// Serve accepts connections on ln until Close; it always returns a non-nil
// error (ErrServerClosed after Close).
func (s *Server) Serve(ln net.Listener) error {
	if err := s.track(ln); err != nil {
		return err
	}
	return s.serve(ln)
}

func (s *Server) track(ln net.Listener) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return ErrServerClosed
	}
	s.listeners[ln] = struct{}{}
	return nil
}

func (s *Server) serve(ln net.Listener) error {
	var delay time.Duration
	for {
		nc, err := ln.Accept()
		if err != nil {
			s.mu.Lock()
			closed := s.closed
			s.mu.Unlock()
			if closed {
				return ErrServerClosed
			}
			var ne net.Error
			if errors.As(err, &ne) && ne.Timeout() || !errors.Is(err, net.ErrClosed) {
				if delay == 0 {
					delay = 5 * time.Millisecond
				} else if delay *= 2; delay > time.Second {
					delay = time.Second
				}
				s.log.Warn("smpp server: accept error", "err", err, "retry_in", delay)
				time.Sleep(delay)
				continue
			}
			return err
		}
		delay = 0
		s.accept(nc)
	}
}

func (s *Server) accept(nc net.Conn) {
	c := &conn{srv: s, id: fmt.Sprintf("s%d", s.nextID.Add(1)), remote: nc.RemoteAddr()}
	finished := make(chan struct{}) // closed once all Handler calls returned
	c.sess = session.New(nc, session.Config{
		WindowSize:            s.cfg.WindowSize,
		RequestTimeout:        s.cfg.RequestTimeout,
		EnquireLinkInterval:   s.cfg.EnquireLinkInterval,
		MaxInboundConcurrency: s.cfg.MaxInboundConcurrency,
		Handler:               c.handle,
		Logger:                s.cfg.Logger,
		OnClose:               func(*session.Session, error) { close(finished) },
	})
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		nc.Close()
		return
	}
	s.conns[c] = struct{}{}
	s.mu.Unlock()
	c.bindTimer = time.AfterFunc(s.cfg.BindTimeout, func() {
		if !c.isBound() {
			s.log.Info("smpp server: bind timeout", "remote", c.remote.String())
			c.sess.Close()
		}
	})
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		<-c.sess.Done()
		c.bindTimer.Stop()
		s.remove(c)
		if info, ok := c.boundInfo(); ok {
			reason := ""
			if err := c.sess.Err(); err != nil {
				reason = err.Error()
			}
			s.events.add(BindEvent{
				Time: time.Now(), Type: "unbound", SystemID: info.SystemID, OrgID: info.OrgID,
				RemoteAddr: info.RemoteAddr, BindType: info.BindType.String(), SessionID: info.ID, Reason: reason,
			})
			if s.cfg.OnUnbind != nil {
				s.cfg.OnUnbind(info, c.sess.Err())
			}
		}
		<-finished
	}()
	c.sess.Start()
}

func (s *Server) remove(c *conn) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.conns, c)
	if c.ident != nil {
		if m := s.bySystem[c.ident.SystemID]; m != nil {
			delete(m, c)
			if len(m) == 0 {
				delete(s.bySystem, c.ident.SystemID)
			}
		}
	}
}

// reserve registers c under id.SystemID if max_binds allows, and records the
// identity and bind type (under s.mu, so registry readers see them).
func (s *Server) reserve(c *conn, id *Identity, bt pdu.BindType) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return false
	}
	select {
	case <-c.sess.Done():
		return false
	default:
	}
	m := s.bySystem[id.SystemID]
	if id.MaxBinds > 0 && len(m) >= id.MaxBinds {
		return false
	}
	if m == nil {
		m = map[*conn]struct{}{}
		s.bySystem[id.SystemID] = m
	}
	m[c] = struct{}{}
	c.ident = id
	c.bindType = bt
	return true
}

// Sessions lists bound sessions, sorted by system_id then bound time.
func (s *Server) Sessions() []SessionInfo {
	s.mu.Lock()
	var cs []*conn
	for _, m := range s.bySystem {
		for c := range m {
			cs = append(cs, c)
		}
	}
	s.mu.Unlock()
	out := make([]SessionInfo, 0, len(cs))
	for _, c := range cs {
		if info, ok := c.boundInfo(); ok {
			out = append(out, info)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].SystemID != out[j].SystemID {
			return out[i].SystemID < out[j].SystemID
		}
		return out[i].BoundSince.Before(out[j].BoundSince)
	})
	return out
}

func (s *Server) boundConns(match func(*Identity) bool) []*conn {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []*conn
	for _, m := range s.bySystem {
		for c := range m {
			if c.ident != nil && match(c.ident) {
				out = append(out, c)
			}
		}
	}
	return out
}

// Kick unbinds every session of orgID (used after suspend / SMPP disable /
// password rotation) and returns how many sessions were kicked. Sessions
// stop receiving Deliver traffic immediately; Kick waits up to 2s for the
// unbind handshakes.
func (s *Server) Kick(orgID string) int {
	return s.kick(s.boundConns(func(id *Identity) bool { return id.OrgID == orgID }))
}

// KickSystemID unbinds every session of systemID.
func (s *Server) KickSystemID(systemID string) int {
	return s.kick(s.boundConns(func(id *Identity) bool { return id.SystemID == systemID }))
}

func (s *Server) kick(cs []*conn) int {
	var wg sync.WaitGroup
	for _, c := range cs {
		c.kicked.Store(true)
		s.remove(c)
		wg.Add(1)
		go func(c *conn) {
			defer wg.Done()
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			_ = c.sess.Unbind(ctx)
		}(c)
	}
	wg.Wait()
	return len(cs)
}

// Deliver sends d to one bound RX/TRX session of systemID, whatever its
// organization. Gateway code delivering tenant data must use DeliverTo.
func (s *Server) Deliver(ctx context.Context, systemID string, d *pdu.DeliverSM) (*pdu.DeliverSMResp, error) {
	return s.DeliverTo(ctx, "", systemID, d)
}

// DeliverTo sends d to one bound RX/TRX session of systemID that belongs to
// orgID (round robin) and waits for deliver_sm_resp (bounded by ctx and
// Config.RequestTimeout). If a chosen session turns out to be closed, the
// next one is tried. orgID "" matches any organization. Matching the
// organization matters because a system_id can be deleted and re-created
// by another tenant while receipts for the old one are still queued.
//
// Results mirror client.Submit: (resp, nil) on success, (resp,
// *pdu.StatusError) when the ESME answered with an error, ErrNoSession when
// no receiver is bound, or a session/ctx error when the outcome is unknown.
// d is not modified.
func (s *Server) DeliverTo(ctx context.Context, orgID, systemID string, d *pdu.DeliverSM) (*pdu.DeliverSMResp, error) {
	s.mu.Lock()
	var cands []*conn
	for c := range s.bySystem[systemID] {
		if c.receives(orgID) {
			cands = append(cands, c)
		}
	}
	start := s.rr[systemID]
	s.rr[systemID]++
	s.mu.Unlock()
	if len(cands) == 0 {
		return nil, ErrNoSession
	}
	sort.Slice(cands, func(i, j int) bool { return cands[i].id < cands[j].id })
	for i := range cands {
		c := cands[(int(start%uint64(len(cands)))+i)%len(cands)]
		resp, err := c.sess.Request(ctx, d)
		if errors.Is(err, session.ErrClosed) {
			continue
		}
		if err != nil {
			return nil, err
		}
		r := resp.(*pdu.DeliverSMResp)
		if r.Status != pdu.ESME_ROK {
			return r, &pdu.StatusError{Command: pdu.CmdDeliverSMResp, Status: r.Status}
		}
		return r, nil
	}
	return nil, ErrNoSession
}

// HasReceiver reports whether systemID has a bound RX/TRX session (any
// organization).
func (s *Server) HasReceiver(systemID string) bool { return s.HasReceiverFor("", systemID) }

// HasReceiverFor reports whether systemID has a bound RX/TRX session of
// orgID ("" = any organization).
func (s *Server) HasReceiverFor(orgID, systemID string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	for c := range s.bySystem[systemID] {
		if c.receives(orgID) {
			return true
		}
	}
	return false
}

// ReceiverCountFor reports how many bound, delivery-ready RX/TRX sessions
// systemID has for orgID ("" = any organization). It uses the same readiness
// predicate as delivery, so a non-zero count means that many sessions are
// eligible to receive deliver_sm right now.
func (s *Server) ReceiverCountFor(orgID, systemID string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	n := 0
	for c := range s.bySystem[systemID] {
		if c.receives(orgID) {
			n++
		}
	}
	return n
}

// ReceiverKey identifies a bound receiver (RX/TRX) session owner.
type ReceiverKey struct {
	OrgID, SystemID string
}

// Receivers lists the distinct (org, system_id) pairs with a bound RX/TRX
// session on this server.
func (s *Server) Receivers() []ReceiverKey {
	s.mu.Lock()
	defer s.mu.Unlock()
	seen := map[ReceiverKey]bool{}
	var out []ReceiverKey
	for _, m := range s.bySystem {
		for c := range m {
			if !c.receives("") {
				continue
			}
			k := ReceiverKey{OrgID: c.ident.OrgID, SystemID: c.ident.SystemID}
			if !seen[k] {
				seen[k] = true
				out = append(out, k)
			}
		}
	}
	return out
}

// receives reports whether c may get deliver_sm for orgID (under s.mu).
func (c *conn) receives(orgID string) bool {
	return c.ready.Load() && !c.kicked.Load() && c.bindType.CanReceive() &&
		c.ident != nil && (orgID == "" || c.ident.OrgID == orgID)
}

// Close stops listening, unbinds all sessions (≤2s), cancels the Handler
// context and waits until every connection goroutine and every in-flight
// Handler call has returned. Pending multipart sets are dropped without
// OnIncomplete.
func (s *Server) Close() error {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return nil
	}
	s.closed = true
	for ln := range s.listeners {
		ln.Close()
	}
	var all []*conn
	for c := range s.conns {
		all = append(all, c)
	}
	s.mu.Unlock()

	var wg sync.WaitGroup
	for _, c := range all {
		wg.Add(1)
		go func(c *conn) {
			defer wg.Done()
			if c.isBound() {
				ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
				_ = c.sess.Unbind(ctx)
				cancel()
			}
			c.sess.Close()
		}(c)
	}
	wg.Wait()
	s.cancel()
	s.concat.stop()
	s.wg.Wait()
	return nil
}
