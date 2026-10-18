package dispatch

import (
	"context"
	"crypto/tls"
	"errors"
	"log/slog"
	"net"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"golang.org/x/time/rate"

	"smsgw/engine/internal/metrics"
	"smsgw/engine/internal/smpp/client"
	"smsgw/engine/internal/smpp/pdu"
	"smsgw/engine/internal/smpp/session"
	"smsgw/engine/internal/store"
)

// DeliverFunc handles a deliver_sm received on an upstream session of
// connection connID (delivery receipts). Its return value is the
// deliver_sm_resp command_status.
type DeliverFunc func(connID string, d *pdu.DeliverSM) pdu.CommandStatus

// upConn is one upstream connection: N client sessions sharing a token
// bucket of max_tps.
type upConn struct {
	id      string
	cfg     *store.Connection // as bound (session-relevant fields)
	clients []*client.Client
	limiter *rate.Limiter
	log     *slog.Logger

	rr        atomic.Uint64
	waiting   atomic.Int64 // PDUs waiting for a token / window slot
	submitted atomic.Uint64
	failed    atomic.Uint64
	meter     *metrics.RateMeter

	closeOnce sync.Once
}

func bucketBurst(tps int) int {
	b := tps / 10
	if b < 1 {
		b = 1
	}
	return b
}

// newUpConn starts the sessions of c (none if disabled or the password could
// not be decrypted).
func newUpConn(c *store.Connection, onDeliver DeliverFunc, tlsCfg func(*store.Connection) *tls.Config, log *slog.Logger) (*upConn, error) {
	u := &upConn{
		id:      c.ID,
		cfg:     c,
		limiter: rate.NewLimiter(rate.Limit(max(c.MaxTPS, 1)), bucketBurst(c.MaxTPS)),
		log:     log.With("connection_id", c.ID, "connection", c.Name),
		meter:   metrics.NewRateMeter(nil),
	}
	if !c.Enabled || c.PasswordErr != nil {
		return u, nil
	}
	bt, err := pdu.ParseBindType(c.BindType)
	if err != nil {
		return nil, err
	}
	var tc *tls.Config
	if c.UseTLS {
		if tlsCfg != nil {
			tc = tlsCfg(c)
		} else {
			tc = &tls.Config{ServerName: c.Host, MinVersion: tls.VersionTLS12}
		}
	}
	n := max(c.Sessions, 1)
	for i := 0; i < n; i++ {
		cl, err := client.New(client.Config{
			Addr:                net.JoinHostPort(c.Host, strconv.Itoa(c.Port)),
			TLS:                 tc,
			BindType:            bt,
			SystemID:            c.SystemID,
			Password:            c.Password,
			SystemType:          c.SystemType,
			WindowSize:          max(c.WindowSize, 1),
			RequestTimeout:      positive(c.SubmitTimeout, 10*time.Second),
			EnquireLinkInterval: positive(c.EnquireLinkInterval, 30*time.Second),
			ReconnectMin:        positive(c.ReconnectMin, time.Second),
			ReconnectMax:        positive(c.ReconnectMax, 60*time.Second),
			OnDeliver: func(d *pdu.DeliverSM) pdu.CommandStatus {
				if onDeliver == nil {
					return pdu.ESME_ROK
				}
				return onDeliver(c.ID, d)
			},
			Logger: u.log.With("session", i),
		})
		if err != nil {
			u.close()
			return nil, err
		}
		u.clients = append(u.clients, cl)
	}
	return u, nil
}

func positive(d, def time.Duration) time.Duration {
	if d <= 0 {
		return def
	}
	return d
}

// close unbinds every session (each bounded by 2s), in parallel.
func (u *upConn) close() {
	u.closeOnce.Do(func() {
		var wg sync.WaitGroup
		for _, c := range u.clients {
			wg.Add(1)
			go func(c *client.Client) { defer wg.Done(); _ = c.Close() }(c)
		}
		wg.Wait()
	})
}

// drainAndClose waits (up to max) for outstanding submits, then closes.
func (u *upConn) drainAndClose(maxWait time.Duration) {
	deadline := time.Now().Add(maxWait)
	for time.Now().Before(deadline) && (u.inFlight() > 0 || u.waiting.Load() > 0) {
		time.Sleep(20 * time.Millisecond)
	}
	u.close()
}

func (u *upConn) inFlight() int {
	n := 0
	for _, c := range u.clients {
		n += c.InFlight()
	}
	return n
}

// canTransmit reports whether at least one TX/TRX session is bound.
func (u *upConn) canTransmit() bool {
	for _, c := range u.clients {
		if c.BindType().CanTransmit() && c.State().Status.Bound() {
			return true
		}
	}
	return false
}

// pickClient returns the bound transmitter with the fewest outstanding
// submits (round-robin among ties), skipping exclude.
func (u *upConn) pickClient(exclude map[*client.Client]bool) *client.Client {
	n := len(u.clients)
	if n == 0 {
		return nil
	}
	start := int(u.rr.Add(1) % uint64(n))
	var best *client.Client
	bestLoad := 0
	for i := 0; i < n; i++ {
		c := u.clients[(start+i)%n]
		if exclude[c] || !c.BindType().CanTransmit() || !c.State().Status.Bound() {
			continue
		}
		if l := c.InFlight(); best == nil || l < bestLoad {
			best, bestLoad = c, l
		}
	}
	return best
}

// errNoSession means no bound transmitter was available on the connection.
var errNoSession = errors.New("dispatch: no bound transmitter session")

// submit sends one PDU, waiting for a token first. A session that turns out
// not to be bound is skipped in favour of another one.
func (u *upConn) submit(ctx context.Context, sm *pdu.SubmitSM, m *metrics.Engine) (*pdu.SubmitSMResp, error) {
	u.waiting.Add(1)
	err := u.limiter.Wait(ctx)
	u.waiting.Add(-1)
	if err != nil {
		return nil, err
	}
	tried := map[*client.Client]bool{}
	for {
		c := u.pickClient(tried)
		if c == nil {
			return nil, errNoSession
		}
		tried[c] = true
		start := time.Now()
		resp, err := c.Submit(ctx, sm)
		if errors.Is(err, client.ErrNotBound) || errors.Is(err, client.ErrNotTransmitter) {
			continue // lost the bind between pick and submit: try another session
		}
		if m != nil {
			m.UpstreamLatency.Observe(time.Since(start).Seconds())
			m.TPSOut.Add(1)
		}
		u.meter.Add(1)
		result := "ok"
		switch {
		case err == nil:
			u.submitted.Add(1)
		case isTimeout(err):
			result = "timeout"
			u.failed.Add(1)
		default:
			result = "error"
			u.failed.Add(1)
		}
		if m != nil {
			m.UpstreamSubmit.With(u.id, result).Inc()
		}
		return resp, err
	}
}

func isTimeout(err error) bool {
	return errors.Is(err, context.DeadlineExceeded) || errors.Is(err, session.ErrTimeout)
}

// SessionStatus is one session in GET /internal/v1/connections/status.
type SessionStatus struct {
	Index      int        `json:"index"`
	State      string     `json:"state"`
	BoundSince *time.Time `json:"bound_since"`
	LastError  *string    `json:"last_error"`
}

// ConnStatus is one connection in GET /internal/v1/connections/status.
type ConnStatus struct {
	ConnectionID   string          `json:"connection_id"`
	Name           string          `json:"name"`
	Enabled        bool            `json:"enabled"`
	State          string          `json:"state"` // BOUND | CONNECTING | DOWN | DISABLED
	Sessions       []SessionStatus `json:"sessions"`
	TPSLimit       int             `json:"tps_limit"`
	TPSCurrent     float64         `json:"tps_current"`
	InFlight       int             `json:"inflight"`
	QueueDepth     int64           `json:"queue_depth"`
	SubmittedTotal uint64          `json:"submitted_total"`
	FailedTotal    uint64          `json:"failed_total"`
}

func (u *upConn) status(name string, enabled bool, maxTPS int, backlog int64) ConnStatus {
	st := ConnStatus{
		ConnectionID: u.id, Name: name, Enabled: enabled, Sessions: []SessionStatus{},
		TPSLimit: maxTPS, TPSCurrent: u.meter.Rate(), InFlight: u.inFlight(),
		QueueDepth: u.waiting.Load() + backlog, SubmittedTotal: u.submitted.Load(), FailedTotal: u.failed.Load(),
	}
	bound, connecting := 0, 0
	for i, c := range u.clients {
		s := c.State()
		ss := SessionStatus{Index: i, State: string(s.Status)}
		if s.Status.Bound() {
			bound++
			t := s.BoundSince.UTC()
			ss.BoundSince = &t
		} else if s.Status == client.StatusConnecting {
			connecting++
		}
		if s.LastError != "" {
			e := s.LastError
			ss.LastError = &e
		}
		st.Sessions = append(st.Sessions, ss)
	}
	switch {
	case !enabled:
		st.State = "DISABLED"
	case u.cfg.PasswordErr != nil:
		st.State = "DOWN"
		e := "password cannot be decrypted: " + u.cfg.PasswordErr.Error()
		st.Sessions = append(st.Sessions, SessionStatus{Index: 0, State: "DOWN", LastError: &e})
	case bound > 0:
		st.State = "BOUND"
	case connecting > 0:
		st.State = "CONNECTING"
	default:
		st.State = "DOWN"
	}
	return st
}
