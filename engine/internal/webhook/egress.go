package webhook

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"syscall"
	"time"
)

// SSRF guard for webhook deliveries. Webhook URLs are chosen by clients, and
// the engine POSTs to them from inside the platform network; the status code
// and error of every attempt land in webhook_deliveries, which the client can
// read. With Options.BlockPrivate the dialer refuses any connection whose
// resolved address is not public unicast (loopback, RFC 1918, CGNAT,
// link-local incl. cloud metadata, unique-local, multicast, reserved,
// documentation, and IPv4 embedded in mapped / NAT64 / 6to4 IPv6). The check
// runs on the address actually dialed (net.Dialer.Control), so a DNS answer
// that changes after the api validated the URL (rebinding) can't reach an
// internal service. The api applies the same rules when a webhook is saved.

var blockedPrefixes = func() []netip.Prefix {
	var out []netip.Prefix
	for _, s := range []string{
		"0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12",
		"192.0.0.0/24", "192.0.2.0/24", "192.88.99.0/24", "192.168.0.0/16", "198.18.0.0/15",
		"198.51.100.0/24", "203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4",
		"::/128", "::1/128", "100::/64", "2001:db8::/32", "fc00::/7", "fe80::/10", "fec0::/10", "ff00::/8",
	} {
		out = append(out, netip.MustParsePrefix(s))
	}
	return out
}()

var (
	nat64    = netip.MustParsePrefix("64:ff9b::/96")
	sixTo4   = netip.MustParsePrefix("2002::/16")
	v4compat = netip.MustParsePrefix("::/96")
)

// BlockedAddr reports whether a is not a public unicast address.
func BlockedAddr(a netip.Addr) bool {
	a = a.WithZone("")
	if a.Is4In6() {
		return BlockedAddr(a.Unmap())
	}
	if a.Is6() {
		b := a.As16()
		switch {
		case nat64.Contains(a), v4compat.Contains(a) && a != netip.IPv6Unspecified() && a != netip.IPv6Loopback():
			return BlockedAddr(netip.AddrFrom4([4]byte{b[12], b[13], b[14], b[15]}))
		case sixTo4.Contains(a):
			return BlockedAddr(netip.AddrFrom4([4]byte{b[2], b[3], b[4], b[5]}))
		}
	}
	for _, p := range blockedPrefixes {
		if p.Contains(a) {
			return true
		}
	}
	return !a.IsValid()
}

// ErrBlockedTarget is returned (wrapped) when a webhook target resolves to a
// non-public address.
var ErrBlockedTarget = errors.New("webhook target address is not allowed (private, loopback or reserved)")

func dialControl(_, address string, _ syscall.RawConn) error {
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		return err
	}
	a, err := netip.ParseAddr(host)
	if err != nil || BlockedAddr(a) {
		return fmt.Errorf("%w: %s", ErrBlockedTarget, host)
	}
	return nil
}

// guardedClient is the default delivery client with BlockPrivate: no proxy
// (the proxy's own address would be private), no redirects, and the dial
// guard on every connection.
func guardedClient(timeout time.Duration) *http.Client {
	d := &net.Dialer{Timeout: timeout, KeepAlive: 30 * time.Second, Control: dialControl}
	tr := &http.Transport{
		Proxy: nil,
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			return d.DialContext(ctx, network, addr)
		},
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          100,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   10 * time.Second,
		ExpectContinueTimeout: time.Second,
	}
	return &http.Client{
		Timeout:       timeout,
		Transport:     tr,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
}
