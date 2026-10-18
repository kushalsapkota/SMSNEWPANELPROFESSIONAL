package webhook

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"testing"
	"time"
)

func TestBlockedAddr(t *testing.T) {
	for _, s := range []string{"127.0.0.1", "10.2.3.4", "172.16.9.9", "192.168.0.1", "169.254.169.254", "100.64.1.1", "0.0.0.0",
		"224.0.0.5", "255.255.255.255", "::1", "::", "fe80::1%eth0", "fd12::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1",
		"64:ff9b::a00:1", "2002:a00:1::1", "::127.0.0.1", "2001:db8::1"} {
		if !BlockedAddr(netip.MustParseAddr(s)) {
			t.Errorf("%s should be blocked", s)
		}
	}
	for _, s := range []string{"8.8.8.8", "93.184.215.14", "172.32.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8", "64:ff9b::808:808"} {
		if BlockedAddr(netip.MustParseAddr(s)) {
			t.Errorf("%s should be allowed", s)
		}
	}
}

// With BlockPrivate the default client refuses to connect to a loopback
// target (here a live local server that would otherwise answer 200).
func TestGuardedClientRefusesPrivateTargets(t *testing.T) {
	hits := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { hits++ }))
	defer srv.Close()

	q := New(nil, nil, nil, Options{BlockPrivate: true, Timeout: 2 * time.Second})
	req, _ := http.NewRequestWithContext(context.Background(), http.MethodPost, srv.URL, nil)
	_, err := q.hc.Do(req)
	if err == nil || !errors.Is(err, ErrBlockedTarget) {
		t.Fatalf("expected ErrBlockedTarget, got %v", err)
	}
	// "localhost" resolves to loopback: blocked at dial time as well.
	req, _ = http.NewRequestWithContext(context.Background(), http.MethodPost, "http://localhost:"+srv.URL[len("http://127.0.0.1:"):], nil)
	if _, err := q.hc.Do(req); err == nil || !errors.Is(err, ErrBlockedTarget) {
		t.Fatalf("localhost: expected ErrBlockedTarget, got %v", err)
	}
	if hits != 0 {
		t.Fatalf("target was reached %d times", hits)
	}
	// Without the guard (dev/tests) the same target is reachable.
	open := New(nil, nil, nil, Options{Timeout: 2 * time.Second})
	req, _ = http.NewRequestWithContext(context.Background(), http.MethodPost, srv.URL, nil)
	res, err := open.hc.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if hits != 1 {
		t.Fatalf("hits %d", hits)
	}
}
