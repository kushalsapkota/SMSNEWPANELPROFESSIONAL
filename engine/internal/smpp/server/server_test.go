package server_test

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"smsgw/engine/internal/smpp/client"
	"smsgw/engine/internal/smpp/coding"
	"smsgw/engine/internal/smpp/pdu"
	"smsgw/engine/internal/smpp/server"
	"smsgw/engine/internal/smpp/session"
)

var quiet = slog.New(slog.NewTextHandler(io.Discard, nil))

type account struct {
	org, password string
	bindTypes     []pdu.BindType
	maxBinds, tps int
}

type testHandler struct {
	mu      sync.Mutex
	n       atomic.Uint64
	msgs    []*server.Message
	status  pdu.CommandStatus
	block   chan struct{}
	got     chan *server.Message
	current atomic.Int32
	peak    atomic.Int32
}

func newHandler() *testHandler { return &testHandler{got: make(chan *server.Message, 100)} }

func (h *testHandler) NewMessageID() string { return fmt.Sprintf("msg-%d", h.n.Add(1)) }

func (h *testHandler) HandleMessage(ctx context.Context, m *server.Message) pdu.CommandStatus {
	n := h.current.Add(1)
	defer h.current.Add(-1)
	for {
		p := h.peak.Load()
		if n <= p || h.peak.CompareAndSwap(p, n) {
			break
		}
	}
	if h.block != nil {
		<-h.block
	}
	h.mu.Lock()
	h.msgs = append(h.msgs, m)
	st := h.status
	h.mu.Unlock()
	h.got <- m
	return st
}

type fixture struct {
	t        *testing.T
	srv      *server.Server
	addr     string
	h        *testHandler
	accounts map[string]account
	expired  chan server.IncompleteMessage
}

func newFixture(t *testing.T, mut func(*server.Config)) *fixture {
	t.Helper()
	f := &fixture{t: t, h: newHandler(), expired: make(chan server.IncompleteMessage, 10), accounts: map[string]account{
		"alice":  {org: "org-a", password: "pw", maxBinds: 5},
		"alice2": {org: "org-a", password: "pw", maxBinds: 5},
		"bob":    {org: "org-b", password: "pw", maxBinds: 5},
		"txonly": {org: "org-c", password: "pw", bindTypes: []pdu.BindType{pdu.BindTransmitter}},
		"two":    {org: "org-d", password: "pw", maxBinds: 2},
		"slow":   {org: "org-e", password: "pw", tps: 5},
	}}
	cfg := server.Config{
		Authenticator: server.AuthenticatorFunc(func(ctx context.Context, r *server.BindRequest) (*server.Identity, pdu.CommandStatus) {
			a, ok := f.accounts[r.SystemID]
			if !ok {
				return nil, pdu.ESME_RINVSYSID
			}
			if a.password != r.Password {
				return nil, pdu.ESME_RINVPASWD
			}
			if r.RemoteAddr == nil {
				return nil, pdu.ESME_RBINDFAIL
			}
			return &server.Identity{OrgID: a.org, SystemID: r.SystemID, AllowedBindTypes: a.bindTypes, MaxBinds: a.maxBinds, TPS: a.tps}, pdu.ESME_ROK
		}),
		Handler:             f.h,
		EnquireLinkInterval: -1,
		RequestTimeout:      2 * time.Second,
		OnIncomplete:        func(m server.IncompleteMessage) { f.expired <- m },
		Logger:              quiet,
	}
	if mut != nil {
		mut(&cfg)
	}
	srv, err := server.New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	a, err := srv.Listen("127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	f.srv, f.addr = srv, a.String()
	t.Cleanup(func() { srv.Close() })
	return f
}

func (f *fixture) client(systemID string, bt pdu.BindType, mut func(*client.Config)) *client.Client {
	f.t.Helper()
	cfg := client.Config{Addr: f.addr, SystemID: systemID, Password: "pw", BindType: bt, Logger: quiet,
		ReconnectMin: 20 * time.Millisecond, ReconnectMax: 100 * time.Millisecond, EnquireLinkInterval: -1, RequestTimeout: 3 * time.Second}
	if mut != nil {
		mut(&cfg)
	}
	c, err := client.New(cfg)
	if err != nil {
		f.t.Fatal(err)
	}
	f.t.Cleanup(func() { c.Close() })
	return c
}

func waitBound(t *testing.T, c *client.Client) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := c.WaitBound(ctx); err != nil {
		t.Fatalf("not bound: %v (state %+v)", err, c.State())
	}
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func gsmSubmit(src, dst, text string) *pdu.SubmitSM {
	b, err := coding.EncodeGSM7(text)
	if err != nil {
		panic(err)
	}
	return &pdu.SubmitSM{SourceAddrTON: 5, SourceAddr: src, DestAddrTON: 1, DestAddrNPI: 1, DestinationAddr: dst, RegisteredDelivery: 1, ShortMessage: b}
}

func TestBindAndSubmit(t *testing.T) {
	f := newFixture(t, nil)
	c := f.client("alice", pdu.BindTransceiver, nil)
	waitBound(t, c)
	st := c.State()
	if st.Status != client.StatusBoundTRX || st.BoundSince.IsZero() || st.SMSCSystemID != "SMSGW" {
		t.Fatalf("%+v", st)
	}
	resp, err := c.Submit(context.Background(), gsmSubmit("MYBANK", "919876543210", "Your code is 849201 €"))
	if err != nil {
		t.Fatal(err)
	}
	m := <-f.h.got
	if resp.MessageID != m.ID || m.ID == "" || len(m.PartIDs) != 1 {
		t.Fatalf("resp %q msg %q", resp.MessageID, m.ID)
	}
	if m.Text != "Your code is 849201 €" || m.SourceAddr != "MYBANK" || m.SourceTON != 5 || m.DestAddr != "919876543210" ||
		m.DestTON != 1 || m.DestNPI != 1 || m.RegisteredDelivery != 1 || m.DataCoding != 0 || m.Parts != 1 ||
		m.Session.OrgID != "org-a" || m.Session.SystemID != "alice" || m.Session.BindType != pdu.BindTransceiver || m.Command != pdu.CmdSubmitSM {
		t.Fatalf("%+v", m)
	}
	sessions := f.srv.Sessions()
	if len(sessions) != 1 || sessions[0].SubmittedTotal != 1 || sessions[0].OrgID != "org-a" || sessions[0].RemoteAddr == "" {
		t.Fatalf("%+v", sessions)
	}
}

func TestHandlerStatusPropagates(t *testing.T) {
	f := newFixture(t, nil)
	f.h.status = pdu.ESME_RSUBMITFAIL
	c := f.client("alice", pdu.BindTransmitter, nil)
	waitBound(t, c)
	resp, err := c.Submit(context.Background(), gsmSubmit("A", "1", "x"))
	var se *pdu.StatusError
	if !errors.As(err, &se) || se.Status != pdu.ESME_RSUBMITFAIL || resp == nil || resp.MessageID != "" {
		t.Fatalf("resp %+v err %v", resp, err)
	}
}

func TestBindRejections(t *testing.T) {
	f := newFixture(t, nil)
	cases := []struct {
		sys, pw string
		bt      pdu.BindType
		want    pdu.CommandStatus
	}{
		{"alice", "bad", pdu.BindTransceiver, pdu.ESME_RINVPASWD},
		{"nobody", "pw", pdu.BindTransceiver, pdu.ESME_RINVSYSID},
		{"txonly", "pw", pdu.BindReceiver, pdu.ESME_RBINDFAIL},
	}
	for _, cs := range cases {
		c := f.client(cs.sys, cs.bt, func(cfg *client.Config) { cfg.Password = cs.pw })
		waitFor(t, "bind failure", func() bool {
			st := c.State()
			return st.Status == client.StatusDown && strings.Contains(st.LastError, cs.want.String())
		})
		c.Close()
	}
	c := f.client("txonly", pdu.BindTransmitter, nil)
	waitBound(t, c)
}

func TestMaxBinds(t *testing.T) {
	f := newFixture(t, nil)
	c1 := f.client("two", pdu.BindTransmitter, nil)
	c2 := f.client("two", pdu.BindTransceiver, nil)
	waitBound(t, c1)
	waitBound(t, c2)
	c3 := f.client("two", pdu.BindTransmitter, nil)
	waitFor(t, "third bind rejected", func() bool {
		return strings.Contains(c3.State().LastError, "ESME_RBINDFAIL")
	})
	if n := len(f.srv.Sessions()); n != 2 {
		t.Fatalf("sessions %d", n)
	}
	c1.Close()
	waitBound(t, c3) // slot freed; c3's reconnect loop gets in
	if n := len(f.srv.Sessions()); n != 2 {
		t.Fatalf("sessions %d", n)
	}
}

func TestThrottling(t *testing.T) {
	f := newFixture(t, nil)
	c := f.client("slow", pdu.BindTransmitter, func(cfg *client.Config) { cfg.WindowSize = 20 })
	waitBound(t, c)
	var ok, throttled atomic.Int32
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := c.Submit(context.Background(), gsmSubmit("A", "1", "x"))
			var se *pdu.StatusError
			switch {
			case err == nil:
				ok.Add(1)
			case errors.As(err, &se) && se.Status == pdu.ESME_RTHROTTLED:
				throttled.Add(1)
			default:
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	if ok.Load() < 5 || ok.Load() > 7 || throttled.Load() == 0 {
		t.Fatalf("ok %d throttled %d", ok.Load(), throttled.Load())
	}
	time.Sleep(400 * time.Millisecond) // refill ~2 tokens
	if _, err := c.Submit(context.Background(), gsmSubmit("A", "1", "x")); err != nil {
		t.Fatalf("after refill: %v", err)
	}
}

func TestKick(t *testing.T) {
	unbound := make(chan string, 10)
	f2 := newFixture(t, func(c *server.Config) {
		c.OnUnbind = func(i server.SessionInfo, err error) { unbound <- i.SystemID }
	})
	a1 := f2.client("alice", pdu.BindTransceiver, func(c *client.Config) { c.ReconnectMin = time.Hour; c.ReconnectMax = time.Hour })
	a2 := f2.client("alice2", pdu.BindTransmitter, func(c *client.Config) { c.ReconnectMin = time.Hour; c.ReconnectMax = time.Hour })
	b := f2.client("bob", pdu.BindTransceiver, nil)
	waitBound(t, a1)
	waitBound(t, a2)
	waitBound(t, b)
	if n := f2.srv.Kick("org-a"); n != 2 {
		t.Fatalf("kicked %d", n)
	}
	waitFor(t, "org-a clients down", func() bool {
		return !a1.State().Status.Bound() && !a2.State().Status.Bound()
	})
	if !b.State().Status.Bound() {
		t.Fatal("org-b affected")
	}
	for i := 0; i < 2; i++ {
		select {
		case s := <-unbound:
			if !strings.HasPrefix(s, "alice") {
				t.Fatal(s)
			}
		case <-time.After(2 * time.Second):
			t.Fatal("OnUnbind not called")
		}
	}
	ss := f2.srv.Sessions()
	if len(ss) != 1 || ss[0].SystemID != "bob" {
		t.Fatalf("%+v", ss)
	}
	if n := f2.srv.KickSystemID("bob"); n != 1 {
		t.Fatal(n)
	}
	if n := f2.srv.Kick("org-none"); n != 0 {
		t.Fatal(n)
	}
}

func TestDeliverRoundRobin(t *testing.T) {
	f := newFixture(t, nil)
	var got [3]atomic.Int32
	mk := func(i int, bt pdu.BindType) *client.Client {
		return f.client("alice", bt, func(c *client.Config) {
			c.OnDeliver = func(d *pdu.DeliverSM) pdu.CommandStatus {
				got[i].Add(1)
				if string(d.ShortMessage) == "reject" {
					return pdu.ESME_RX_T_APPN
				}
				return pdu.ESME_ROK
			}
		})
	}
	c0 := mk(0, pdu.BindReceiver)
	c1 := mk(1, pdu.BindTransceiver)
	c2 := mk(2, pdu.BindTransmitter) // must never get deliveries
	for _, c := range []*client.Client{c0, c1, c2} {
		waitBound(t, c)
	}
	waitFor(t, "receiver ready", func() bool { return f.srv.HasReceiver("alice") })
	r := pdu.Receipt{ID: "msg-1", Sub: 1, Dlvrd: 1, Stat: "DELIVRD", Err: "000", Text: "hello"}
	d := &pdu.DeliverSM{SourceAddr: "919876543210", DestinationAddr: "MYBANK", ESMClass: pdu.ESMClassMCDeliveryRcpt, ShortMessage: []byte(r.Format())}
	d.TLVs.SetReceiptedMessageID("msg-1")
	d.TLVs.SetMessageState(pdu.StateDelivered)
	for i := 0; i < 10; i++ {
		if _, err := f.srv.Deliver(context.Background(), "alice", d); err != nil {
			t.Fatal(err)
		}
	}
	if got[0].Load() != 5 || got[1].Load() != 5 || got[2].Load() != 0 {
		t.Fatalf("distribution %d %d %d", got[0].Load(), got[1].Load(), got[2].Load())
	}
	_, err := f.srv.Deliver(context.Background(), "alice", &pdu.DeliverSM{ShortMessage: []byte("reject")})
	var se *pdu.StatusError
	if !errors.As(err, &se) || se.Status != pdu.ESME_RX_T_APPN {
		t.Fatal(err)
	}
	if _, err := f.srv.Deliver(context.Background(), "bob", d); !errors.Is(err, server.ErrNoSession) {
		t.Fatal(err)
	}
}

func TestDeliverTimeout(t *testing.T) {
	f := newFixture(t, func(c *server.Config) { c.RequestTimeout = 100 * time.Millisecond })
	release := make(chan struct{})
	defer close(release)
	c := f.client("alice", pdu.BindReceiver, func(cfg *client.Config) {
		cfg.OnDeliver = func(*pdu.DeliverSM) pdu.CommandStatus { <-release; return 0 }
	})
	waitBound(t, c)
	waitFor(t, "receiver", func() bool { return f.srv.HasReceiver("alice") })
	if _, err := f.srv.Deliver(context.Background(), "alice", &pdu.DeliverSM{}); !errors.Is(err, session.ErrTimeout) {
		t.Fatal(err)
	}
}

// submitParts sends PDUs concurrently-ish in the given order and returns responses by index.
func submitParts(t *testing.T, c *client.Client, parts []*pdu.SubmitSM, order []int) []*pdu.SubmitSMResp {
	t.Helper()
	out := make([]*pdu.SubmitSMResp, len(parts))
	for _, i := range order {
		r, err := c.Submit(context.Background(), parts[i])
		if err != nil {
			t.Fatalf("part %d: %v", i, err)
		}
		out[i] = r
	}
	return out
}

func TestMultipartUDH8(t *testing.T) {
	f := newFixture(t, nil)
	c := f.client("alice", pdu.BindTransceiver, nil)
	waitBound(t, c)
	text := strings.Repeat("Hello world {€} ", 20) // 320 chars, 360 septets -> 3 parts
	p, err := coding.Prepare(text)
	if err != nil {
		t.Fatal(err)
	}
	msgs := p.WithUDH(42)
	if len(msgs) != 3 {
		t.Fatal(len(msgs))
	}
	var pdus []*pdu.SubmitSM
	for _, m := range msgs {
		pdus = append(pdus, &pdu.SubmitSM{SourceAddr: "SRC", DestinationAddr: "123", ESMClass: pdu.ESMClassUDHI, DataCoding: 0, ShortMessage: m})
	}
	// Interleave a single message in between: must not interfere.
	resps := submitParts(t, c, pdus, []int{2, 0})
	if _, err := c.Submit(context.Background(), gsmSubmit("SRC", "123", "single")); err != nil {
		t.Fatal(err)
	}
	single := <-f.h.got
	if single.Text != "single" {
		t.Fatal(single.Text)
	}
	select {
	case <-f.h.got:
		t.Fatal("handler called before multipart completion")
	default:
	}
	resps[1] = submitParts(t, c, pdus, []int{1})[1]
	m := <-f.h.got
	if m.Text != text || m.Parts != 3 || m.Multipart != server.MultipartUDH8 {
		t.Fatalf("got %q parts %d kind %s", m.Text, m.Parts, m.Multipart)
	}
	for i, r := range resps {
		if r.MessageID != m.ID {
			t.Fatalf("part %d id %q != %q", i, r.MessageID, m.ID)
		}
	}
	if len(m.PartIDs) != 3 || m.PartIDs[0] != m.ID {
		t.Fatal(m.PartIDs)
	}
	if m.ESMClass&pdu.ESMClassUDHI == 0 {
		t.Fatal("esm_class")
	}
}

func TestMultipartUDH16UCS2(t *testing.T) {
	f := newFixture(t, nil)
	c := f.client("alice", pdu.BindTransceiver, nil)
	waitBound(t, c)
	text := strings.Repeat("Привет 😀 ", 15)
	segs, err := coding.EncodeSegments(text, coding.UCS2)
	if err != nil {
		t.Fatal(err)
	}
	var pdus []*pdu.SubmitSM
	for i, s := range segs {
		sm := append(coding.ConcatUDH16(0xBEEF, uint8(len(segs)), uint8(i+1)), s...)
		pdus = append(pdus, &pdu.SubmitSM{SourceAddr: "S", DestinationAddr: "9", ESMClass: pdu.ESMClassUDHI, DataCoding: 8, ShortMessage: sm})
	}
	order := make([]int, len(pdus))
	for i := range order {
		order[i] = len(pdus) - 1 - i
	}
	resps := submitParts(t, c, pdus, order)
	m := <-f.h.got
	if m.Text != text || m.Multipart != server.MultipartUDH16 || m.Parts != len(segs) || m.DataCoding != 8 {
		t.Fatalf("%q %s", m.Text, m.Multipart)
	}
	for _, r := range resps {
		if r.MessageID != m.ID {
			t.Fatal("ids differ")
		}
	}
}

func TestMultipartSARAndPerPartIDs(t *testing.T) {
	f := newFixture(t, func(c *server.Config) { c.PerPartMessageIDs = true })
	c := f.client("alice", pdu.BindTransceiver, nil)
	waitBound(t, c)
	text := strings.Repeat("abcdefghij", 31) // 310 -> 3 parts
	segs, _ := coding.EncodeSegments(text, coding.GSM7)
	var pdus []*pdu.SubmitSM
	for i, s := range segs {
		p := &pdu.SubmitSM{SourceAddr: "S", DestinationAddr: "9", ShortMessage: s}
		p.TLVs.SetSAR(777, uint8(len(segs)), uint8(i+1))
		pdus = append(pdus, p)
	}
	resps := submitParts(t, c, pdus, []int{1, 0, 2})
	m := <-f.h.got
	if m.Text != text || m.Multipart != server.MultipartSAR || m.Parts != 3 {
		t.Fatalf("%q %s", m.Text, m.Multipart)
	}
	seen := map[string]bool{}
	for i, r := range resps {
		if r.MessageID != m.PartIDs[i] || seen[r.MessageID] {
			t.Fatalf("part %d: %q vs %v", i, r.MessageID, m.PartIDs)
		}
		seen[r.MessageID] = true
	}
	if m.ID != resps[1].MessageID { // first-arriving part
		t.Fatal("ID should be the first-arriving part's id")
	}
}

func TestMultipartAcrossSessions(t *testing.T) {
	f := newFixture(t, nil)
	c1 := f.client("alice", pdu.BindTransmitter, nil)
	c2 := f.client("alice", pdu.BindTransmitter, nil)
	waitBound(t, c1)
	waitBound(t, c2)
	p, _ := coding.Prepare(strings.Repeat("z", 200))
	msgs := p.WithUDH(9)
	r1, err := c1.Submit(context.Background(), &pdu.SubmitSM{SourceAddr: "S", DestinationAddr: "1", ESMClass: 0x40, ShortMessage: msgs[0]})
	if err != nil {
		t.Fatal(err)
	}
	r2, err := c2.Submit(context.Background(), &pdu.SubmitSM{SourceAddr: "S", DestinationAddr: "1", ESMClass: 0x40, ShortMessage: msgs[1]})
	if err != nil {
		t.Fatal(err)
	}
	m := <-f.h.got
	if m.Text != strings.Repeat("z", 200) || r1.MessageID != r2.MessageID {
		t.Fatal("cross-session reassembly failed")
	}
}

func TestIncompleteExpiry(t *testing.T) {
	f := newFixture(t, func(c *server.Config) { c.ConcatTimeout = 100 * time.Millisecond })
	c := f.client("alice", pdu.BindTransmitter, nil)
	waitBound(t, c)
	p, _ := coding.Prepare(strings.Repeat("q", 400))
	msgs := p.WithUDH(1)
	r, err := c.Submit(context.Background(), &pdu.SubmitSM{SourceAddr: "S", DestinationAddr: "7", ESMClass: 0x40, ShortMessage: msgs[1]})
	if err != nil {
		t.Fatal(err)
	}
	select {
	case inc := <-f.expired:
		if inc.ID != r.MessageID || inc.Received != 1 || inc.Total != 3 || inc.DestAddr != "7" || inc.Session.SystemID != "alice" {
			t.Fatalf("%+v", inc)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("no expiry")
	}
	select {
	case <-f.h.got:
		t.Fatal("handler called for incomplete message")
	default:
	}
	// a late part starts a new set rather than completing the old one
	if _, err := c.Submit(context.Background(), &pdu.SubmitSM{SourceAddr: "S", DestinationAddr: "7", ESMClass: 0x40, ShortMessage: msgs[0]}); err != nil {
		t.Fatal(err)
	}
	<-f.expired
}

func TestMessagePayloadAndBadUDH(t *testing.T) {
	f := newFixture(t, nil)
	c := f.client("alice", pdu.BindTransmitter, nil)
	waitBound(t, c)
	text := strings.Repeat("long payload ", 50)
	sm := &pdu.SubmitSM{SourceAddr: "S", DestinationAddr: "1", DataCoding: 8}
	sm.TLVs.SetMessagePayload(coding.EncodeUCS2(text))
	if _, err := c.Submit(context.Background(), sm); err != nil {
		t.Fatal(err)
	}
	m := <-f.h.got
	if m.Text != text || m.Multipart != server.MultipartPayload {
		t.Fatalf("%q", m.Text)
	}
	_, err := c.Submit(context.Background(), &pdu.SubmitSM{ESMClass: 0x40, ShortMessage: []byte{0x09, 0x00}})
	var se *pdu.StatusError
	if !errors.As(err, &se) || se.Status != pdu.ESME_RINVESMCLASS {
		t.Fatal(err)
	}
	bad := &pdu.SubmitSM{}
	bad.TLVs.SetSAR(1, 2, 3)
	_, err = c.Submit(context.Background(), bad)
	if !errors.As(err, &se) || se.Status != pdu.ESME_RINVOPTPARAMVAL {
		t.Fatal(err)
	}
}

// raw dials and returns a started session without binding.
func raw(t *testing.T, addr string) *session.Session {
	nc, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	s := session.New(nc, session.Config{EnquireLinkInterval: -1, Logger: quiet})
	s.Start()
	t.Cleanup(func() { s.Close() })
	return s
}

func TestBindStateEnforcement(t *testing.T) {
	f := newFixture(t, nil)
	s := raw(t, f.addr)
	ctx := context.Background()
	resp, err := s.Request(ctx, &pdu.SubmitSM{})
	if err != nil || resp.Hdr().Status != pdu.ESME_RINVBNDSTS {
		t.Fatal(resp, err)
	}
	resp, err = s.Request(ctx, &pdu.Bind{BindType: pdu.BindReceiver, SystemID: "alice", Password: "pw"})
	if err != nil || resp.Hdr().Status != pdu.ESME_ROK || resp.(*pdu.BindResp).SystemID != "SMSGW" {
		t.Fatal(resp, err)
	}
	if v, ok := resp.(*pdu.BindResp).TLVs.SCInterfaceVersion(); !ok || v != 0x34 {
		t.Fatal("sc_interface_version")
	}
	resp, _ = s.Request(ctx, &pdu.Bind{BindType: pdu.BindReceiver, SystemID: "alice", Password: "pw"})
	if resp.Hdr().Status != pdu.ESME_RALYBND {
		t.Fatal(resp.Hdr().Status)
	}
	resp, _ = s.Request(ctx, &pdu.SubmitSM{}) // RX can't submit
	if resp.Hdr().Status != pdu.ESME_RINVBNDSTS {
		t.Fatal(resp.Hdr().Status)
	}
	resp, err = s.Request(ctx, &pdu.EnquireLink{})
	if err != nil || resp.CommandID() != pdu.CmdEnquireLinkResp {
		t.Fatal(err)
	}
}

func TestDataSM(t *testing.T) {
	f := newFixture(t, nil)
	s := raw(t, f.addr)
	ctx := context.Background()
	if r, err := s.Request(ctx, &pdu.Bind{BindType: pdu.BindTransmitter, SystemID: "alice", Password: "pw"}); err != nil || r.Hdr().Status != 0 {
		t.Fatal(r, err)
	}
	d := &pdu.DataSM{SourceAddr: "S", DestinationAddr: "5", RegisteredDelivery: 1}
	d.TLVs.SetMessagePayload([]byte("via data sm"))
	resp, err := s.Request(ctx, d)
	if err != nil {
		t.Fatal(err)
	}
	m := <-f.h.got
	if resp.(*pdu.DataSMResp).MessageID != m.ID || m.Text != "via data sm" || m.Command != pdu.CmdDataSM {
		t.Fatalf("%+v", m)
	}
}

func TestBindTimeout(t *testing.T) {
	f := newFixture(t, func(c *server.Config) { c.BindTimeout = 100 * time.Millisecond })
	s := raw(t, f.addr)
	select {
	case <-s.Done():
	case <-time.After(2 * time.Second):
		t.Fatal("unbound connection not closed")
	}
}

func TestEnquireLinkKeepsSessionAlive(t *testing.T) {
	f := newFixture(t, func(c *server.Config) { c.EnquireLinkInterval = 30 * time.Millisecond })
	c := f.client("alice", pdu.BindTransceiver, func(cfg *client.Config) { cfg.EnquireLinkInterval = 30 * time.Millisecond })
	waitBound(t, c)
	since := c.State().BoundSince
	time.Sleep(300 * time.Millisecond)
	st := c.State()
	if !st.Status.Bound() || !st.BoundSince.Equal(since) {
		t.Fatalf("session flapped: %+v", st)
	}
}

func TestServerCloseUnbindsClients(t *testing.T) {
	f := newFixture(t, nil)
	c := f.client("alice", pdu.BindTransceiver, nil)
	waitBound(t, c)
	f.srv.Close()
	waitFor(t, "client down", func() bool { return !c.State().Status.Bound() })
	if _, err := f.srv.Listen("127.0.0.1:0"); !errors.Is(err, server.ErrServerClosed) {
		t.Fatal(err)
	}
}
