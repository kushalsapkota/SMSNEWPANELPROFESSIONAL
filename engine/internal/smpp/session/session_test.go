package session

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"net"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"smsgw/engine/internal/smpp/pdu"
)

func tcpPair(t *testing.T) (net.Conn, net.Conn) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	ch := make(chan net.Conn, 1)
	go func() {
		c, _ := ln.Accept()
		ch <- c
	}()
	a, err := net.Dial("tcp", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	b := <-ch
	t.Cleanup(func() { a.Close(); b.Close() })
	return a, b
}

func echoSubmitHandler(delay time.Duration) RequestHandler {
	return func(s *Session, req pdu.PDU) {
		if sm, ok := req.(*pdu.SubmitSM); ok {
			time.Sleep(delay)
			r := pdu.NewResponse(req, pdu.ESME_ROK).(*pdu.SubmitSMResp)
			r.MessageID = string(sm.ShortMessage)
			_ = s.Respond(r)
			return
		}
		_ = s.Respond(pdu.NewResponse(req, pdu.ESME_RINVCMDID))
	}
}

func TestRequestCorrelation(t *testing.T) {
	a, b := tcpPair(t)
	cli := New(a, Config{WindowSize: 50, EnquireLinkInterval: -1})
	srv := New(b, Config{Handler: func(s *Session, req pdu.PDU) {
		// answer in reverse-ish order using random delays
		sm := req.(*pdu.SubmitSM)
		time.Sleep(time.Duration(sm.ShortMessage[0]%7) * time.Millisecond)
		r := pdu.NewResponse(req, pdu.ESME_ROK).(*pdu.SubmitSMResp)
		r.MessageID = string(sm.ShortMessage)
		_ = s.Respond(r)
	}, EnquireLinkInterval: -1})
	cli.Start()
	srv.Start()
	defer cli.Close()
	defer srv.Close()

	var wg sync.WaitGroup
	for i := 0; i < 200; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			body := []byte(fmt.Sprintf("m%d", i))
			resp, err := cli.Request(context.Background(), &pdu.SubmitSM{ShortMessage: body})
			if err != nil {
				t.Error(err)
				return
			}
			if got := resp.(*pdu.SubmitSMResp).MessageID; got != string(body) {
				t.Errorf("mismatched response %q != %q", got, body)
			}
		}(i)
	}
	wg.Wait()
	if cli.InFlight() != 0 {
		t.Fatal("window not released")
	}
}

func TestWindowEnforced(t *testing.T) {
	a, b := tcpPair(t)
	var cur, max atomic.Int32
	release := make(chan struct{})
	srv := New(b, Config{EnquireLinkInterval: -1, Handler: func(s *Session, req pdu.PDU) {
		n := cur.Add(1)
		for {
			m := max.Load()
			if n <= m || max.CompareAndSwap(m, n) {
				break
			}
		}
		<-release
		cur.Add(-1)
		_ = s.Respond(pdu.NewResponse(req, pdu.ESME_ROK))
	}})
	cli := New(a, Config{WindowSize: 3, EnquireLinkInterval: -1})
	srv.Start()
	cli.Start()
	defer cli.Close()
	defer srv.Close()

	var wg sync.WaitGroup
	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := cli.Request(context.Background(), &pdu.SubmitSM{}); err != nil {
				t.Error(err)
			}
		}()
	}
	time.Sleep(100 * time.Millisecond)
	if cli.InFlight() != 3 || cur.Load() != 3 {
		t.Fatalf("inflight %d, server concurrent %d", cli.InFlight(), cur.Load())
	}
	// a context-bounded request cannot get a slot
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	_, err := cli.Request(ctx, &pdu.SubmitSM{})
	cancel()
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("want deadline exceeded, got %v", err)
	}
	close(release)
	wg.Wait()
	if max.Load() != 3 {
		t.Fatalf("max concurrent %d", max.Load())
	}
}

func TestTimeoutReleasesWindow(t *testing.T) {
	a, b := tcpPair(t)
	srv := New(b, Config{EnquireLinkInterval: -1, Handler: func(s *Session, req pdu.PDU) {}}) // never answers
	cli := New(a, Config{WindowSize: 1, RequestTimeout: 50 * time.Millisecond, EnquireLinkInterval: -1})
	srv.Start()
	cli.Start()
	defer cli.Close()
	defer srv.Close()
	for i := 0; i < 3; i++ {
		start := time.Now()
		_, err := cli.Request(context.Background(), &pdu.SubmitSM{})
		if !errors.Is(err, ErrTimeout) {
			t.Fatalf("want timeout, got %v", err)
		}
		if time.Since(start) > time.Second {
			t.Fatal("timeout too slow")
		}
	}
	if cli.InFlight() != 0 {
		t.Fatal("slot leaked")
	}
}

func TestEnquireLinkAutoAnswerAndKeepalive(t *testing.T) {
	a, b := tcpPair(t)
	cli := New(a, Config{EnquireLinkInterval: 30 * time.Millisecond, RequestTimeout: time.Second})
	srv := New(b, Config{EnquireLinkInterval: -1})
	cli.Start()
	srv.Start()
	defer cli.Close()
	defer srv.Close()
	// srv auto-answers; cli keeps sending because nothing else is received
	resp, err := srv.Request(context.Background(), &pdu.EnquireLink{})
	if err != nil || resp.CommandID() != pdu.CmdEnquireLinkResp {
		t.Fatal(resp, err)
	}
	time.Sleep(200 * time.Millisecond)
	select {
	case <-cli.Done():
		t.Fatalf("keepalive closed a healthy session: %v", cli.Err())
	default:
	}
}

func TestDeadPeerDetection(t *testing.T) {
	a, b := tcpPair(t)
	// b is a raw socket that reads but never answers
	go func() {
		buf := make([]byte, 1024)
		for {
			if _, err := b.Read(buf); err != nil {
				return
			}
		}
	}()
	closed := make(chan error, 2)
	cli := New(a, Config{EnquireLinkInterval: 40 * time.Millisecond, RequestTimeout: 60 * time.Millisecond,
		OnClose: func(s *Session, err error) { closed <- err }})
	cli.Start()
	select {
	case err := <-closed:
		if !errors.Is(err, ErrDeadPeer) {
			t.Fatalf("want ErrDeadPeer, got %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("dead peer not detected")
	}
	select {
	case <-closed:
		t.Fatal("OnClose called twice")
	case <-time.After(50 * time.Millisecond):
	}
}

func TestPeerUnbindAndLocalUnbind(t *testing.T) {
	a, b := tcpPair(t)
	cliClosed := make(chan error, 1)
	srvClosed := make(chan error, 1)
	cli := New(a, Config{EnquireLinkInterval: -1, OnClose: func(s *Session, err error) { cliClosed <- err }})
	srv := New(b, Config{EnquireLinkInterval: -1, OnClose: func(s *Session, err error) { srvClosed <- err }})
	cli.Start()
	srv.Start()
	if err := cli.Unbind(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := <-srvClosed; !errors.Is(err, ErrUnbound) {
		t.Fatalf("server: %v", err)
	}
	if err := <-cliClosed; !errors.Is(err, ErrClosed) {
		t.Fatalf("client: %v", err)
	}
	if _, err := cli.Request(context.Background(), &pdu.SubmitSM{}); !errors.Is(err, ErrClosed) {
		t.Fatal(err)
	}
}

func TestCloseFailsPending(t *testing.T) {
	a, b := tcpPair(t)
	srv := New(b, Config{EnquireLinkInterval: -1, Handler: func(s *Session, req pdu.PDU) {}})
	cli := New(a, Config{EnquireLinkInterval: -1})
	srv.Start()
	cli.Start()
	errc := make(chan error)
	go func() {
		_, err := cli.Request(context.Background(), &pdu.SubmitSM{})
		errc <- err
	}()
	time.Sleep(30 * time.Millisecond)
	srv.Close() // peer goes away
	select {
	case err := <-errc:
		if !errors.Is(err, ErrClosed) {
			t.Fatalf("got %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("pending request not failed")
	}
	<-cli.Done()
	if cli.Err() == nil {
		t.Fatal("no close reason")
	}
}

func TestMalformedAndUnknown(t *testing.T) {
	a, b := tcpPair(t)
	srv := New(b, Config{EnquireLinkInterval: -1, Handler: echoSubmitHandler(0)})
	srv.Start()
	defer srv.Close()

	// truncated submit_sm body with consistent length
	bad := make([]byte, 20)
	binary.BigEndian.PutUint32(bad, 20)
	binary.BigEndian.PutUint32(bad[4:], uint32(pdu.CmdSubmitSM))
	binary.BigEndian.PutUint32(bad[12:], 11)
	bad[16] = 'x' // service_type without NUL
	if _, err := a.Write(bad); err != nil {
		t.Fatal(err)
	}
	p, err := pdu.ReadPDU(a)
	if err != nil {
		t.Fatal(err)
	}
	if p.CommandID() != pdu.CmdGenericNack || p.Hdr().Sequence != 11 || p.Hdr().Status == pdu.ESME_ROK {
		t.Fatalf("%#v", p)
	}
	// unknown command -> handler answers with generic_nack
	unk := make([]byte, 16)
	binary.BigEndian.PutUint32(unk, 16)
	binary.BigEndian.PutUint32(unk[4:], 0x0000_0042)
	binary.BigEndian.PutUint32(unk[12:], 12)
	a.Write(unk)
	p, err = pdu.ReadPDU(a)
	if err != nil || p.CommandID() != pdu.CmdGenericNack || p.Hdr().Status != pdu.ESME_RINVCMDID || p.Hdr().Sequence != 12 {
		t.Fatalf("%#v %v", p, err)
	}
	// still works
	b2, _ := pdu.Marshal(&pdu.SubmitSM{Header: pdu.Header{Sequence: 13}, ShortMessage: []byte("ok")})
	a.Write(b2)
	p, err = pdu.ReadPDU(a)
	if err != nil || p.(*pdu.SubmitSMResp).MessageID != "ok" {
		t.Fatal(p, err)
	}
	// invalid command_length closes the session
	binary.BigEndian.PutUint32(unk, 3)
	a.Write(unk)
	select {
	case <-srv.Done():
	case <-time.After(time.Second):
		t.Fatal("not closed on invalid length")
	}
}

func TestGenericNackResponse(t *testing.T) {
	a, b := tcpPair(t)
	srv := New(b, Config{EnquireLinkInterval: -1, Handler: func(s *Session, req pdu.PDU) {
		n := &pdu.GenericNack{}
		n.Sequence = req.Hdr().Sequence
		n.Status = pdu.ESME_RSYSERR
		_ = s.Respond(n)
	}})
	cli := New(a, Config{EnquireLinkInterval: -1})
	srv.Start()
	cli.Start()
	defer srv.Close()
	defer cli.Close()
	_, err := cli.Request(context.Background(), &pdu.SubmitSM{})
	var se *pdu.StatusError
	if !errors.As(err, &se) || se.Status != pdu.ESME_RSYSERR {
		t.Fatalf("got %v", err)
	}
}

func TestNotStartedAndBadArgs(t *testing.T) {
	a, _ := tcpPair(t)
	s := New(a, Config{})
	if _, err := s.Request(context.Background(), &pdu.EnquireLink{}); !errors.Is(err, ErrNotStarted) {
		t.Fatal(err)
	}
	s.Start()
	defer s.Close()
	if _, err := s.Request(context.Background(), &pdu.EnquireLinkResp{}); err == nil {
		t.Fatal("request with response accepted")
	}
	if err := s.Respond(&pdu.EnquireLink{}); err == nil {
		t.Fatal("respond with request accepted")
	}
}

func TestSequenceWrap(t *testing.T) {
	a, _ := tcpPair(t)
	s := New(a, Config{})
	s.seq.Store(0x7FFFFFFE)
	if s.nextSeq() != 0x7FFFFFFF || s.nextSeq() != 1 {
		t.Fatal("wrap")
	}
}
