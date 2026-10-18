package client_test

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	"smsgw/engine/internal/smpp/client"
	"smsgw/engine/internal/smpp/pdu"
	"smsgw/engine/internal/smpp/server"
)

// An SMSC that accepts the bind and drops the session right away must not
// be redialled at ReconnectMin forever: the backoff keeps growing until a
// session stays up for StableAfter.
func TestBackoffGrowsWhenSessionsDropRightAfterBind(t *testing.T) {
	var binds atomic.Int32
	var srv *server.Server
	srv, err := server.New(server.Config{
		Authenticator: auth(), Handler: &handler{}, Logger: quiet, EnquireLinkInterval: -1,
		OnBind: func(info server.SessionInfo) {
			binds.Add(1)
			go srv.KickSystemID(info.SystemID) // session-limit style drop after bind
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	addr, err := srv.Listen("127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer srv.Close()
	newClient(t, client.Config{Addr: addr.String(), BindType: pdu.BindTransceiver,
		ReconnectMin: 50 * time.Millisecond, ReconnectMax: 2 * time.Second, StableAfter: time.Minute})
	time.Sleep(1500 * time.Millisecond)
	// Fixed 50ms pauses would give ~25 binds; doubling from 50ms gives ~5.
	if n := binds.Load(); n < 2 || n > 8 {
		t.Fatalf("binds in 1.5s: %d (backoff not growing)", n)
	}
}

// A session that stayed bound for StableAfter resets the backoff.
func TestBackoffResetsAfterStableSession(t *testing.T) {
	h := &handler{}
	srv, addr := startServer(t, "127.0.0.1:0", h, nil)
	c := newClient(t, client.Config{Addr: addr, BindType: pdu.BindTransceiver,
		ReconnectMin: 50 * time.Millisecond, ReconnectMax: 5 * time.Second, StableAfter: 200 * time.Millisecond})
	waitBound(t, c, 2*time.Second)
	for i := 0; i < 3; i++ {
		time.Sleep(300 * time.Millisecond) // stable
		srv.KickSystemID("esme")
		start := time.Now()
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		for c.State().Status.Bound() && ctx.Err() == nil {
			time.Sleep(5 * time.Millisecond)
		}
		if err := c.WaitBound(ctx); err != nil {
			t.Fatal(err)
		}
		cancel()
		if d := time.Since(start); d > time.Second {
			t.Fatalf("reconnect %d took %v: backoff not reset after a stable session", i, d)
		}
	}
}
