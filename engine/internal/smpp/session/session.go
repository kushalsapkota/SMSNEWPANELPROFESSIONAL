// Package session is the connection core shared by the SMPP client (ESME)
// and server (SMSC): a read loop, serialized writes, sequence numbering,
// request/response correlation with per-request timeouts, a window that caps
// outstanding requests, enquire_link keepalive with dead-peer detection,
// graceful unbind and close notification.
//
// Bind state is NOT tracked here; client and server layer that on top.
//
// Lifecycle:
//
//	s := session.New(conn, cfg) // nothing runs yet
//	s.Start()                   // starts the read loop and keepalive
//	resp, err := s.Request(ctx, &pdu.SubmitSM{...})
//	s.Unbind(ctx)               // or s.Close()
//	<-s.Done()
package session

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"sync"
	"sync/atomic"
	"time"

	"smsgw/engine/internal/smpp/pdu"
)

// Errors reported by Session.
var (
	ErrClosed     = errors.New("smpp: session closed")
	ErrTimeout    = errors.New("smpp: request timed out")
	ErrDeadPeer   = errors.New("smpp: peer did not answer enquire_link")
	ErrUnbound    = errors.New("smpp: peer unbound the session")
	ErrNotStarted = errors.New("smpp: session not started")
	// ErrUnexpectedResponse means the peer answered a request with a
	// response of a different command type.
	ErrUnexpectedResponse = errors.New("smpp: unexpected response type")
)

// RequestHandler handles an inbound request PDU (anything except responses,
// enquire_link and unbind, which the session answers itself). It runs on its
// own goroutine (bounded by Config.MaxInboundConcurrency) and must answer via
// s.Respond, normally with pdu.NewResponse(req, status).
type RequestHandler func(s *Session, req pdu.PDU)

// Config tunes a Session. Zero values select the defaults shown.
type Config struct {
	// WindowSize caps outstanding windowed requests (Request). Default 10.
	WindowSize int
	// RequestTimeout bounds the wait for a response. Default 10s.
	RequestTimeout time.Duration
	// EnquireLinkInterval: when nothing was received for this long, an
	// enquire_link is sent; if it is not answered within RequestTimeout the
	// session closes with ErrDeadPeer. Default 30s; negative disables.
	EnquireLinkInterval time.Duration
	// WriteTimeout bounds a single PDU write. Default 10s.
	WriteTimeout time.Duration
	// MaxInboundConcurrency caps concurrently running Handler calls; when
	// reached, the read loop stops reading (TCP back-pressure). Default 64.
	MaxInboundConcurrency int
	// Handler receives inbound requests. If nil, requests are answered
	// with generic_nack / ESME_RINVCMDID responses.
	Handler RequestHandler
	// OnClose is called exactly once, after the read loop has exited and
	// all pending requests have failed, with the reason the session ended.
	OnClose func(s *Session, err error)
	// Logger receives debug/warn logs. Default slog.Default().
	Logger *slog.Logger
}

func (c *Config) withDefaults() Config {
	out := *c
	if out.WindowSize <= 0 {
		out.WindowSize = 10
	}
	if out.RequestTimeout <= 0 {
		out.RequestTimeout = 10 * time.Second
	}
	if out.EnquireLinkInterval == 0 {
		out.EnquireLinkInterval = 30 * time.Second
	}
	if out.WriteTimeout <= 0 {
		out.WriteTimeout = 10 * time.Second
	}
	if out.MaxInboundConcurrency <= 0 {
		out.MaxInboundConcurrency = 64
	}
	if out.Logger == nil {
		out.Logger = slog.Default()
	}
	return out
}

type result struct {
	p   pdu.PDU
	err error
}

// Session is one SMPP connection. All methods are safe for concurrent use.
type Session struct {
	conn net.Conn
	cfg  Config
	log  *slog.Logger

	started   atomic.Bool
	unbinding atomic.Bool
	seq       atomic.Uint32

	wmu sync.Mutex // serializes writes

	mu      sync.Mutex
	pending map[uint32]chan result
	closed  bool
	err     error

	window   chan struct{}
	inbound  chan struct{}
	done     chan struct{}
	readDone chan struct{}
	handlers sync.WaitGroup

	lastRecv atomic.Int64 // unix nanos
	created  time.Time
}

// New wraps conn. Call Start to begin processing; until then Request
// returns ErrNotStarted.
func New(conn net.Conn, cfg Config) *Session {
	c := cfg.withDefaults()
	s := &Session{
		conn:     conn,
		cfg:      c,
		log:      c.Logger.With("remote", conn.RemoteAddr().String()),
		pending:  make(map[uint32]chan result),
		window:   make(chan struct{}, c.WindowSize),
		inbound:  make(chan struct{}, c.MaxInboundConcurrency),
		done:     make(chan struct{}),
		readDone: make(chan struct{}),
		created:  time.Now(),
	}
	s.lastRecv.Store(time.Now().UnixNano())
	return s
}

// Start launches the read loop and keepalive. It is idempotent.
func (s *Session) Start() {
	if !s.started.CompareAndSwap(false, true) {
		return
	}
	go s.readLoop()
	if s.cfg.EnquireLinkInterval > 0 {
		go s.keepalive()
	}
	go func() {
		<-s.readDone
		s.handlers.Wait()
		if s.cfg.OnClose != nil {
			s.cfg.OnClose(s, s.Err())
		}
	}()
}

// RemoteAddr is the peer address.
func (s *Session) RemoteAddr() net.Addr { return s.conn.RemoteAddr() }

// LocalAddr is the local address.
func (s *Session) LocalAddr() net.Addr { return s.conn.LocalAddr() }

// Done is closed when the session has closed.
func (s *Session) Done() <-chan struct{} { return s.done }

// Err returns why the session closed (nil while open).
func (s *Session) Err() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.err
}

// InFlight is the number of windowed requests awaiting a response.
func (s *Session) InFlight() int { return len(s.window) }

// WindowSize is the configured window.
func (s *Session) WindowSize() int { return cap(s.window) }

// nextSeq returns the next sequence number in 1..0x7FFFFFFF.
func (s *Session) nextSeq() uint32 {
	for {
		old := s.seq.Load()
		n := old + 1
		if n > 0x7FFFFFFF {
			n = 1
		}
		if s.seq.CompareAndSwap(old, n) {
			return n
		}
	}
}

func (s *Session) writeBytes(b []byte) error {
	s.wmu.Lock()
	defer s.wmu.Unlock()
	select {
	case <-s.done:
		return ErrClosed
	default:
	}
	_ = s.conn.SetWriteDeadline(time.Now().Add(s.cfg.WriteTimeout))
	_, err := s.conn.Write(b)
	if err != nil {
		s.closeWith(fmt.Errorf("smpp: write: %w", err))
		return ErrClosed
	}
	return nil
}

// Respond writes a response PDU. resp must be a response command with the
// request's sequence number (pdu.NewResponse does both).
func (s *Session) Respond(resp pdu.PDU) error {
	if !resp.CommandID().IsResponse() {
		return fmt.Errorf("smpp: Respond called with request %s", resp.CommandID())
	}
	b, err := pdu.Marshal(resp)
	if err != nil {
		return err
	}
	return s.writeBytes(b)
}

// Request sends req, waiting for a window slot first, and returns the
// matching response. The request's own Header is ignored: a fresh sequence
// number is used and req is not modified, so one PDU value may be sent on
// several sessions.
//
// A response with a non-zero command_status is returned with a nil error
// (inspect resp.Hdr().Status); a generic_nack yields *pdu.StatusError. The
// wait is bounded by ctx and Config.RequestTimeout (ErrTimeout).
func (s *Session) Request(ctx context.Context, req pdu.PDU) (pdu.PDU, error) {
	return s.request(ctx, req, true)
}

func (s *Session) request(ctx context.Context, req pdu.PDU, windowed bool) (pdu.PDU, error) {
	if !s.started.Load() {
		return nil, ErrNotStarted
	}
	if req.CommandID().IsResponse() {
		return nil, fmt.Errorf("smpp: Request called with response %s", req.CommandID())
	}
	if windowed {
		select {
		case s.window <- struct{}{}:
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-s.done:
			return nil, ErrClosed
		}
		defer func() { <-s.window }()
	}
	seq := s.nextSeq()
	b, err := pdu.MarshalWith(req, pdu.ESME_ROK, seq)
	if err != nil {
		return nil, err
	}
	ch := make(chan result, 1)
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return nil, ErrClosed
	}
	s.pending[seq] = ch
	s.mu.Unlock()
	drop := func() {
		s.mu.Lock()
		delete(s.pending, seq)
		s.mu.Unlock()
	}

	if err := s.writeBytes(b); err != nil {
		drop()
		return nil, err
	}
	timer := time.NewTimer(s.cfg.RequestTimeout)
	defer timer.Stop()
	select {
	case r := <-ch:
		if r.err != nil {
			return nil, r.err
		}
		if nack, ok := r.p.(*pdu.GenericNack); ok {
			return nil, &pdu.StatusError{Command: pdu.CmdGenericNack, Status: nack.Status}
		}
		if r.p.CommandID() != req.CommandID().Response() {
			return nil, fmt.Errorf("%w: sent %s, got %s", ErrUnexpectedResponse, req.CommandID(), r.p.CommandID())
		}
		return r.p, nil
	case <-timer.C:
		drop()
		return nil, ErrTimeout
	case <-ctx.Done():
		drop()
		return nil, ctx.Err()
	}
}

// Unbind sends unbind (outside the window), waits for unbind_resp (bounded by
// ctx and RequestTimeout), then closes the connection. The session is closed
// when Unbind returns, whatever the error.
func (s *Session) Unbind(ctx context.Context) error {
	s.unbinding.Store(true)
	_, err := s.request(ctx, &pdu.Unbind{}, false)
	s.closeWith(ErrClosed)
	return err
}

// Close closes the connection immediately. Pending requests fail with ErrClosed.
func (s *Session) Close() error {
	s.closeWith(ErrClosed)
	return nil
}

func (s *Session) closeWith(reason error) {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	s.closed = true
	s.err = reason
	pending := s.pending
	s.pending = nil
	close(s.done)
	s.mu.Unlock()
	_ = s.conn.Close()
	for _, ch := range pending {
		ch <- result{err: ErrClosed}
	}
	if !s.started.Load() {
		// Never started: emulate the read loop exit so OnClose semantics hold.
		if s.started.CompareAndSwap(false, true) {
			close(s.readDone)
			if s.cfg.OnClose != nil {
				go s.cfg.OnClose(s, reason)
			}
		}
	}
}

func (s *Session) readLoop() {
	defer close(s.readDone)
	br := bufio.NewReaderSize(s.conn, 16*1024)
	for {
		p, err := pdu.ReadPDU(br)
		if err != nil {
			var de *pdu.DecodeError
			if errors.As(err, &de) {
				s.lastRecv.Store(time.Now().UnixNano())
				s.onDecodeError(de)
				continue
			}
			select {
			case <-s.done: // we closed it
			default:
				if s.unbinding.Load() {
					// peer closed the socket after answering our unbind
					s.closeWith(ErrClosed)
					return
				}
				if errors.Is(err, io.EOF) || errors.Is(err, net.ErrClosed) {
					err = fmt.Errorf("smpp: connection closed by peer: %w", err)
				} else {
					err = fmt.Errorf("smpp: read: %w", err)
				}
				s.closeWith(err)
			}
			return
		}
		s.lastRecv.Store(time.Now().UnixNano())
		id := p.CommandID()
		if id.IsResponse() {
			s.deliver(p.Hdr().Sequence, result{p: p})
			continue
		}
		switch p.(type) {
		case *pdu.EnquireLink:
			_ = s.Respond(pdu.NewResponse(p, pdu.ESME_ROK))
			continue
		case *pdu.Unbind:
			_ = s.Respond(pdu.NewResponse(p, pdu.ESME_ROK))
			s.closeWith(ErrUnbound)
			return
		}
		if s.cfg.Handler == nil {
			_ = s.Respond(pdu.NewResponse(p, pdu.ESME_RINVCMDID))
			continue
		}
		select {
		case s.inbound <- struct{}{}:
		case <-s.done:
			return
		}
		s.handlers.Add(1)
		go func(p pdu.PDU) {
			defer func() {
				<-s.inbound
				s.handlers.Done()
			}()
			s.cfg.Handler(s, p)
		}(p)
	}
}

func (s *Session) onDecodeError(de *pdu.DecodeError) {
	s.log.Warn("smpp: malformed PDU", "err", de)
	if de.CommandID.IsResponse() {
		s.deliver(de.Sequence, result{err: de})
		return
	}
	nack := &pdu.GenericNack{}
	nack.Status = de.Status
	nack.Sequence = de.Sequence
	_ = s.Respond(nack)
}

func (s *Session) deliver(seq uint32, r result) {
	s.mu.Lock()
	ch, ok := s.pending[seq]
	if ok {
		delete(s.pending, seq)
	}
	s.mu.Unlock()
	if ok {
		ch <- r
	} else if r.p != nil {
		s.log.Debug("smpp: response without pending request", "cmd", r.p.CommandID().String(), "seq", seq)
	}
}

func (s *Session) keepalive() {
	iv := s.cfg.EnquireLinkInterval
	tick := iv / 4
	if tick < 10*time.Millisecond {
		tick = 10 * time.Millisecond
	}
	t := time.NewTicker(tick)
	defer t.Stop()
	for {
		select {
		case <-s.done:
			return
		case <-t.C:
		}
		idle := time.Since(time.Unix(0, s.lastRecv.Load()))
		if idle < iv {
			continue
		}
		ctx, cancel := context.WithTimeout(context.Background(), s.cfg.RequestTimeout)
		_, err := s.request(ctx, &pdu.EnquireLink{}, false)
		cancel()
		switch {
		case err == nil:
		case errors.Is(err, ErrTimeout) || errors.Is(err, context.DeadlineExceeded):
			s.log.Warn("smpp: dead peer, closing session")
			s.closeWith(ErrDeadPeer)
			return
		case errors.Is(err, ErrClosed):
			return
		default:
			// e.g. generic_nack: the peer answered, so it is alive.
			s.log.Debug("smpp: enquire_link answered with error", "err", err)
		}
	}
}
