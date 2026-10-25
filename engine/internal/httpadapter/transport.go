package httpadapter

import (
	"bytes"
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptrace"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
	"unicode/utf8"
)

// UserAgent is sent with every provider request.
const UserAgent = "smsgw/1.0"

// DefaultTimeout bounds every provider request.
const DefaultTimeout = 10 * time.Second

// maxResponseBody caps how much of a provider response is read.
const maxResponseBody = 1 << 20

// Request is an outbound provider request.
type Request struct {
	Method string
	URL    string
	Header http.Header
	Body   []byte
}

// Response is a provider response (body capped at 1 MiB).
type Response struct {
	Status int
	Header http.Header
	Body   []byte
}

// Transport executes provider requests.
type Transport interface {
	Do(ctx context.Context, r *Request) (*Response, error)
}

// TransportError is a request that produced no HTTP response. Sent reports
// whether the whole request had been written before the failure (the
// provider may have processed it); its text never contains the URL.
type TransportError struct {
	Sent    bool
	Timeout bool
	Err     error
}

func (e *TransportError) Error() string {
	what := "network error"
	if e.Timeout {
		what = "timeout"
	}
	if e.Sent {
		what += " after the request was sent"
	} else {
		what += " before the request was sent"
	}
	if e.Err != nil {
		return what + ": " + e.Err.Error()
	}
	return what
}

func (e *TransportError) Unwrap() error { return e.Err }

// HTTPTransport is the production Transport: keep-alive pooling, 10s
// timeout, User-Agent smsgw/1.0. Provider URLs are set by admins, so no
// private-address guard is applied (CONTRACTS http connections).
type HTTPTransport struct {
	Client  *http.Client
	Timeout time.Duration
}

// NewHTTPTransport builds the default transport. tlsCfg may be nil.
func NewHTTPTransport(tlsCfg *tls.Config) *HTTPTransport {
	tr := &http.Transport{
		Proxy:                 http.ProxyFromEnvironment,
		DialContext:           (&net.Dialer{Timeout: 5 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          256,
		MaxIdleConnsPerHost:   64,
		IdleConnTimeout:       50 * time.Second,
		TLSHandshakeTimeout:   5 * time.Second,
		ExpectContinueTimeout: time.Second,
		TLSClientConfig:       tlsCfg,
	}
	return &HTTPTransport{
		Client: &http.Client{Transport: tr, CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse // a redirect is reported as the 3xx it is
		}},
		Timeout: DefaultTimeout,
	}
}

// DefaultTorProxyURL is the default SOCKS5 address for Tor.
const DefaultTorProxyURL = "socks5://127.0.0.1:9050"

// TorTimeout bounds requests routed through Tor (circuits can add latency).
const TorTimeout = 30 * time.Second

// NewTorHTTPTransport builds an HTTP transport routed through a Tor SOCKS5 proxy.
// If torProxyURL is empty, it uses the TOR_PROXY_URL environment variable,
// or defaults to "socks5://127.0.0.1:9050".
func NewTorHTTPTransport(torProxyURL string, tlsCfg *tls.Config) (*HTTPTransport, error) {
	if torProxyURL == "" {
		torProxyURL = os.Getenv("TOR_PROXY_URL")
	}
	if torProxyURL == "" {
		torProxyURL = DefaultTorProxyURL
	}
	u, err := url.Parse(torProxyURL)
	if err != nil {
		return nil, fmt.Errorf("httpadapter: invalid tor proxy url %q: %w", torProxyURL, err)
	}
	tr := &http.Transport{
		Proxy:                 http.ProxyURL(u),
		DialContext:           (&net.Dialer{Timeout: 15 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          256,
		MaxIdleConnsPerHost:   64,
		IdleConnTimeout:       50 * time.Second,
		TLSHandshakeTimeout:   15 * time.Second,
		ExpectContinueTimeout: time.Second,
		TLSClientConfig:       tlsCfg,
	}
	return &HTTPTransport{
		Client: &http.Client{Transport: tr, CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		}},
		Timeout: TorTimeout,
	}, nil
}


// Do executes r.
func (t *HTTPTransport) Do(ctx context.Context, r *Request) (*Response, error) {
	timeout := t.Timeout
	if timeout <= 0 {
		timeout = DefaultTimeout
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	var sent atomic.Bool
	ctx = httptrace.WithClientTrace(ctx, &httptrace.ClientTrace{
		WroteRequest: func(i httptrace.WroteRequestInfo) {
			if i.Err == nil {
				sent.Store(true)
			}
		},
	})
	var body io.Reader
	if r.Body != nil {
		body = bytes.NewReader(r.Body)
	}
	req, err := http.NewRequestWithContext(ctx, r.Method, r.URL, body)
	if err != nil {
		return nil, &TransportError{Err: errors.New("invalid request: " + stripURL(err).Error())}
	}
	for k, vs := range r.Header {
		for _, v := range vs {
			req.Header.Add(k, v)
		}
	}
	req.Header.Set("User-Agent", UserAgent)
	resp, err := t.Client.Do(req)
	if err != nil {
		return nil, &TransportError{Sent: sent.Load(), Timeout: isTimeout(err), Err: stripURL(err)}
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBody))
	if err != nil {
		// The status line arrived: the provider processed the request; the
		// body is lost. Report what we have; adapters treat an unreadable
		// body like an unparseable one.
		b = nil
	}
	return &Response{Status: resp.StatusCode, Header: resp.Header, Body: b}, nil
}

// stripURL drops the request URL (which may hold a token) from net/http
// errors.
func stripURL(err error) error {
	var ue *url.Error
	if errors.As(err, &ue) {
		return ue.Err
	}
	return err
}

func isTimeout(err error) bool {
	if errors.Is(err, context.DeadlineExceeded) {
		return true
	}
	var ne net.Error
	return errors.As(err, &ne) && ne.Timeout()
}

// --- request helpers ---------------------------------------------------------

// formRequest builds a POST application/x-www-form-urlencoded request.
func formRequest(u string, v url.Values) *Request {
	return &Request{Method: http.MethodPost, URL: u, Body: []byte(v.Encode()),
		Header: http.Header{"Content-Type": {"application/x-www-form-urlencoded"}, "Accept": {"application/json"}}}
}

// jsonRequest builds a request with a JSON body.
func jsonRequest(method, u string, body any, hdr http.Header) (*Request, error) {
	b, err := marshalJSON(body)
	if err != nil {
		return nil, err
	}
	h := http.Header{"Content-Type": {"application/json"}, "Accept": {"application/json"}}
	for k, vs := range hdr {
		h[k] = vs
	}
	return &Request{Method: method, URL: u, Body: b, Header: h}, nil
}

// getRequest builds a GET request with query parameters.
func getRequest(u string, q url.Values, hdr http.Header) *Request {
	if len(q) > 0 {
		sep := "?"
		if strings.Contains(u, "?") {
			sep = "&"
		}
		u += sep + q.Encode()
	}
	h := http.Header{"Accept": {"application/json"}}
	for k, vs := range hdr {
		h[k] = vs
	}
	return &Request{Method: http.MethodGet, URL: u, Header: h}
}

// --- outcome helpers ---------------------------------------------------------

// exchange performs r and handles everything that does not need the
// adapter's knowledge: transport errors, 408, 429 and 5xx. When handled is
// false the adapter must interpret resp.
func (c *Conn) exchange(ctx context.Context, r *Request) (resp *Response, res SendResult, handled bool) {
	resp, ex, err := c.do(ctx, r)
	res.Exchange = ex
	if err != nil {
		var te *TransportError
		if !errors.As(err, &te) {
			te = &TransportError{Err: err}
		}
		res.Error = c.Mask(te.Error())
		switch {
		case te.Sent && te.Timeout:
			res.Outcome, res.ErrorCode = Unknown, "SUBMIT_TIMEOUT"
		case te.Sent:
			res.Outcome, res.ErrorCode = Unknown, "SUBMIT_UNKNOWN"
		case ctx.Err() != nil:
			res.Outcome, res.ErrorCode = Retry, "SUBMIT_ABORTED"
		default:
			res.Outcome, res.ErrorCode = Retry, "HTTP_NETWORK"
		}
		return nil, res, true
	}
	res.HTTPStatus = resp.Status
	switch {
	case resp.Status == http.StatusRequestTimeout, resp.Status == http.StatusTooManyRequests,
		resp.Status == http.StatusInternalServerError, resp.Status == http.StatusBadGateway,
		resp.Status == http.StatusServiceUnavailable:
		res.Outcome = Retry
		res.ErrorCode = "HTTP_" + strconv.Itoa(resp.Status)
		res.RetryAfter = retryAfter(resp)
		res.Error = c.Mask(fmt.Sprintf("provider answered HTTP %d: %s", resp.Status, snippet(resp.Body, 200)))
		return resp, res, true
	case resp.Status == http.StatusGatewayTimeout:
		// A gateway gave up waiting for the provider, which may still have
		// processed the request: ambiguous, never resent.
		res.Outcome, res.ErrorCode = Unknown, "SUBMIT_TIMEOUT"
		res.Error = "provider gateway timeout (HTTP 504)"
		return resp, res, true
	}
	return resp, res, false
}

// rejectHTTP classifies a non-2xx response the adapter did not recognise:
// 4xx (other than 408/429, handled earlier) is a definite rejection; any
// other status (3xx, 1xx, unusual 5xx) is treated as retryable.
func (c *Conn) rejectHTTP(res SendResult, resp *Response, msg string) SendResult {
	if msg == "" {
		msg = snippet(resp.Body, 200)
	}
	res.ErrorCode = "HTTP_" + strconv.Itoa(resp.Status)
	res.Error = c.Mask(fmt.Sprintf("HTTP %d: %s", resp.Status, msg))
	if resp.Status >= 400 && resp.Status < 500 {
		res.Outcome = Rejected
	} else {
		res.Outcome = Retry
	}
	return res
}

// unparseable reports a success-looking response whose body could not be
// interpreted: the provider may have accepted the message.
func (c *Conn) unparseable(res SendResult, resp *Response) SendResult {
	res.Outcome = Unknown
	res.ErrorCode = "SUBMIT_UNKNOWN"
	res.Error = c.Mask(fmt.Sprintf("unrecognised provider response (HTTP %d): %s", resp.Status, snippet(resp.Body, 200)))
	return res
}

func retryAfter(resp *Response) time.Duration {
	v := strings.TrimSpace(resp.Header.Get("Retry-After"))
	if v == "" {
		return 0
	}
	if n, err := strconv.Atoi(v); err == nil && n >= 0 {
		return time.Duration(n) * time.Second
	}
	if t, err := http.ParseTime(v); err == nil {
		if d := time.Until(t); d > 0 {
			return d
		}
	}
	return 0
}

// snippet returns at most n bytes of b as text (valid UTF-8, single line).
func snippet(b []byte, n int) string {
	s := strings.TrimSpace(string(b))
	if len(s) > n {
		cut := n
		for cut > 0 && !utf8.RuneStart(s[cut]) {
			cut--
		}
		s = s[:cut] + "…"
	}
	return strings.Join(strings.Fields(s), " ")
}
