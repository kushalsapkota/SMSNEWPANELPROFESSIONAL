package client_test

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math/big"
	"net"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"smsgw/engine/internal/smpp/client"
	"smsgw/engine/internal/smpp/pdu"
	"smsgw/engine/internal/smpp/server"
)

var quiet = slog.New(slog.NewTextHandler(io.Discard, nil))

type handler struct {
	n       atomic.Uint64
	block   chan struct{}
	cur     atomic.Int32
	peak    atomic.Int32
	handled atomic.Int32
}

func (h *handler) NewMessageID() string { return fmt.Sprintf("%x", h.n.Add(1)) }
func (h *handler) HandleMessage(ctx context.Context, m *server.Message) pdu.CommandStatus {
	n := h.cur.Add(1)
	for {
		p := h.peak.Load()
		if n <= p || h.peak.CompareAndSwap(p, n) {
			break
		}
	}
	if h.block != nil {
		<-h.block
	}
	h.cur.Add(-1)
	h.handled.Add(1)
	return pdu.ESME_ROK
}

func auth() server.Authenticator {
	return server.AuthenticatorFunc(func(ctx context.Context, r *server.BindRequest) (*server.Identity, pdu.CommandStatus) {
		if r.Password != "secret" {
			return nil, pdu.ESME_RINVPASWD
		}
		return &server.Identity{OrgID: "o", SystemID: r.SystemID}, pdu.ESME_ROK
	})
}

func startServer(t *testing.T, addr string, h *handler, tlsCfg *tls.Config) (*server.Server, string) {
	t.Helper()
	srv, err := server.New(server.Config{Authenticator: auth(), Handler: h, TLSConfig: tlsCfg, Logger: quiet, EnquireLinkInterval: -1})
	if err != nil {
		t.Fatal(err)
	}
	a, err := srv.Listen(addr)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { srv.Close() })
	return srv, a.String()
}

func newClient(t *testing.T, cfg client.Config) *client.Client {
	t.Helper()
	if cfg.Password == "" {
		cfg.Password = "secret"
	}
	if cfg.SystemID == "" {
		cfg.SystemID = "esme"
	}
	cfg.Logger = quiet
	if cfg.ReconnectMin == 0 {
		cfg.ReconnectMin = 20 * time.Millisecond
		cfg.ReconnectMax = 200 * time.Millisecond
	}
	if cfg.EnquireLinkInterval == 0 {
		cfg.EnquireLinkInterval = -1
	}
	c, err := client.New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close() })
	return c
}

func waitBound(t *testing.T, c *client.Client, d time.Duration) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), d)
	defer cancel()
	if err := c.WaitBound(ctx); err != nil {
		t.Fatalf("not bound: %v (%+v)", err, c.State())
	}
}

func TestConfigValidation(t *testing.T) {
	if _, err := client.New(client.Config{}); err == nil {
		t.Fatal("missing addr accepted")
	}
	if _, err := client.New(client.Config{Addr: "x:1", Password: "123456789"}); err == nil {
		t.Fatal("long password accepted")
	}
}

func TestReconnectAfterServerRestart(t *testing.T) {
	h := &handler{}
	srv, addr := startServer(t, "127.0.0.1:0", h, nil)
	var mu sync.Mutex
	var seen []client.Status
	c := newClient(t, client.Config{Addr: addr, BindType: pdu.BindTransceiver, OnStateChange: func(s client.State) {
		mu.Lock()
		seen = append(seen, s.Status)
		mu.Unlock()
	}})
	waitBound(t, c, 3*time.Second)
	if _, err := c.Submit(context.Background(), &pdu.SubmitSM{ShortMessage: []byte("a")}); err != nil {
		t.Fatal(err)
	}
	srv.Close()
	deadline := time.Now().Add(3 * time.Second)
	for c.State().Status.Bound() && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	st := c.State()
	if st.Status.Bound() || st.LastError == "" {
		t.Fatalf("still bound after server kill: %+v", st)
	}
	if _, err := c.Submit(context.Background(), &pdu.SubmitSM{}); !errors.Is(err, client.ErrNotBound) {
		t.Fatalf("want ErrNotBound, got %v", err)
	}
	// let a few reconnect attempts fail against the closed port
	time.Sleep(150 * time.Millisecond)
	if c.State().Status.Bound() {
		t.Fatal("bound with no server")
	}
	startServer(t, addr, h, nil) // same address
	waitBound(t, c, 5*time.Second)
	st = c.State()
	if st.Reconnects != 1 || st.Status != client.StatusBoundTRX || st.LastError != "" {
		t.Fatalf("%+v", st)
	}
	if _, err := c.Submit(context.Background(), &pdu.SubmitSM{ShortMessage: []byte("b")}); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	defer mu.Unlock()
	var sawConnecting, sawDown bool
	for _, s := range seen {
		sawConnecting = sawConnecting || s == client.StatusConnecting
		sawDown = sawDown || s == client.StatusDown
	}
	if !sawConnecting || !sawDown {
		t.Fatalf("state transitions %v", seen)
	}
}

func TestWindowRespected(t *testing.T) {
	h := &handler{block: make(chan struct{})}
	_, addr := startServer(t, "127.0.0.1:0", h, nil)
	c := newClient(t, client.Config{Addr: addr, BindType: pdu.BindTransmitter, WindowSize: 2})
	waitBound(t, c, 3*time.Second)
	var wg sync.WaitGroup
	for i := 0; i < 6; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := c.Submit(context.Background(), &pdu.SubmitSM{ShortMessage: []byte("x")}); err != nil {
				t.Error(err)
			}
		}()
	}
	time.Sleep(100 * time.Millisecond)
	if c.InFlight() != 2 || h.cur.Load() != 2 || c.State().InFlight != 2 {
		t.Fatalf("inflight %d server %d", c.InFlight(), h.cur.Load())
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	_, err := c.Submit(ctx, &pdu.SubmitSM{})
	cancel()
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal(err)
	}
	close(h.block)
	wg.Wait()
	if h.peak.Load() != 2 || h.handled.Load() != 6 {
		t.Fatalf("peak %d handled %d", h.peak.Load(), h.handled.Load())
	}
}

func TestReceiverCannotSubmit(t *testing.T) {
	_, addr := startServer(t, "127.0.0.1:0", &handler{}, nil)
	c := newClient(t, client.Config{Addr: addr, BindType: pdu.BindReceiver})
	waitBound(t, c, 3*time.Second)
	if c.State().Status != client.StatusBoundRX {
		t.Fatal(c.State())
	}
	if _, err := c.Submit(context.Background(), &pdu.SubmitSM{}); !errors.Is(err, client.ErrNotTransmitter) {
		t.Fatal(err)
	}
}

func TestBindFailureBackoff(t *testing.T) {
	_, addr := startServer(t, "127.0.0.1:0", &handler{}, nil)
	c := newClient(t, client.Config{Addr: addr, Password: "wrong", BindType: pdu.BindTransmitter})
	time.Sleep(200 * time.Millisecond)
	st := c.State()
	if st.Status.Bound() || st.LastError != (&client.BindError{Status: pdu.ESME_RINVPASWD}).Error() {
		t.Fatalf("%+v", st)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if err := c.WaitBound(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal(err)
	}
}

func TestCloseWhileConnecting(t *testing.T) {
	ln, _ := net.Listen("tcp", "127.0.0.1:0")
	addr := ln.Addr().String()
	ln.Close() // nothing listens
	c := newClient(t, client.Config{Addr: addr, ReconnectMin: time.Hour, ReconnectMax: time.Hour})
	time.Sleep(50 * time.Millisecond)
	done := make(chan struct{})
	go func() { c.Close(); close(done) }()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Close blocked during backoff")
	}
	if err := c.WaitBound(context.Background()); !errors.Is(err, client.ErrClientClosed) {
		t.Fatal(err)
	}
	if st := c.State(); st.Status != client.StatusDown {
		t.Fatal(st)
	}
}

func TestDeliverCallbackAndPanic(t *testing.T) {
	srv, addr := startServer(t, "127.0.0.1:0", &handler{}, nil)
	got := make(chan *pdu.DeliverSM, 1)
	c := newClient(t, client.Config{Addr: addr, BindType: pdu.BindTransceiver, OnDeliver: func(d *pdu.DeliverSM) pdu.CommandStatus {
		if string(d.ShortMessage) == "panic" {
			panic("boom")
		}
		got <- d
		return pdu.ESME_ROK
	}})
	waitBound(t, c, 3*time.Second)
	for !srv.HasReceiver("esme") {
		time.Sleep(5 * time.Millisecond)
	}
	rc := pdu.Receipt{ID: "abc", Stat: "DELIVRD", Sub: 1, Dlvrd: 1}
	d := &pdu.DeliverSM{ESMClass: pdu.ESMClassMCDeliveryRcpt, ShortMessage: []byte(rc.Format())}
	if _, err := srv.Deliver(context.Background(), "esme", d); err != nil {
		t.Fatal(err)
	}
	r, ok := pdu.ReceiptFromDeliverSM(<-got)
	if !ok || r.ID != "abc" || r.Stat != "DELIVRD" {
		t.Fatal(r)
	}
	_, err := srv.Deliver(context.Background(), "esme", &pdu.DeliverSM{ShortMessage: []byte("panic")})
	var se *pdu.StatusError
	if !errors.As(err, &se) || se.Status != pdu.ESME_RX_T_APPN {
		t.Fatal(err)
	}
	if !c.State().Status.Bound() {
		t.Fatal("panic killed the session")
	}
}

func selfSigned(t *testing.T) tls.Certificate {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "localhost"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour),
		IPAddresses: []net.IP{net.ParseIP("127.0.0.1")}, DNSNames: []string{"localhost"},
		KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}
}

func TestTLS(t *testing.T) {
	cert := selfSigned(t)
	_, addr := startServer(t, "127.0.0.1:0", &handler{}, &tls.Config{Certificates: []tls.Certificate{cert}})
	pool := x509.NewCertPool()
	leaf, _ := x509.ParseCertificate(cert.Certificate[0])
	pool.AddCert(leaf)
	c := newClient(t, client.Config{Addr: addr, BindType: pdu.BindTransmitter, TLS: &tls.Config{RootCAs: pool, ServerName: "localhost"}})
	waitBound(t, c, 3*time.Second)
	if r, err := c.Submit(context.Background(), &pdu.SubmitSM{ShortMessage: []byte("tls")}); err != nil || r.MessageID == "" {
		t.Fatal(r, err)
	}
	// plain client against TLS server never binds
	p := newClient(t, client.Config{Addr: addr, BindType: pdu.BindTransmitter, BindTimeout: 200 * time.Millisecond})
	time.Sleep(300 * time.Millisecond)
	if p.State().Status.Bound() {
		t.Fatal("plain client bound to TLS server")
	}
}
