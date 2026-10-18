package session

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"smsgw/engine/internal/smpp/pdu"
)

// A peer that submits and then unbinds must still get the responses of the
// submits accepted before the unbind (they may already be billed).
func TestPeerUnbindWaitsForRunningHandlers(t *testing.T) {
	a, b := tcpPair(t)
	srvClosed := make(chan error, 1)
	srv := New(b, Config{EnquireLinkInterval: -1, Handler: echoSubmitHandler(300 * time.Millisecond),
		OnClose: func(s *Session, err error) { srvClosed <- err }})
	cli := New(a, Config{EnquireLinkInterval: -1})
	srv.Start()
	cli.Start()

	var wg sync.WaitGroup
	results := make([]error, 3)
	for i := range results {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			resp, err := cli.Request(context.Background(), &pdu.SubmitSM{ShortMessage: []byte{byte('a' + i)}})
			if err == nil && resp.Hdr().Status != pdu.ESME_ROK {
				err = errors.New(resp.Hdr().Status.String())
			}
			results[i] = err
		}(i)
	}
	time.Sleep(50 * time.Millisecond) // submits are being handled
	start := time.Now()
	if err := cli.Unbind(context.Background()); err != nil {
		t.Fatalf("unbind: %v", err)
	}
	wg.Wait()
	for i, err := range results {
		if err != nil {
			t.Fatalf("submit %d lost its response: %v", i, err)
		}
	}
	if time.Since(start) < 150*time.Millisecond {
		t.Fatal("unbind_resp did not wait for the running handlers")
	}
	if err := <-srvClosed; !errors.Is(err, ErrUnbound) {
		t.Fatalf("server close reason %v", err)
	}
}

func TestPeerUnbindDrainIsBounded(t *testing.T) {
	a, b := tcpPair(t)
	block := make(chan struct{})
	defer close(block)
	srv := New(b, Config{EnquireLinkInterval: -1, UnbindDrainTimeout: 100 * time.Millisecond,
		Handler: func(s *Session, req pdu.PDU) { <-block }})
	cli := New(a, Config{EnquireLinkInterval: -1})
	srv.Start()
	cli.Start()
	go cli.Request(context.Background(), &pdu.SubmitSM{}) //nolint:errcheck
	time.Sleep(30 * time.Millisecond)
	start := time.Now()
	if err := cli.Unbind(context.Background()); err != nil {
		t.Fatal(err)
	}
	if d := time.Since(start); d < 80*time.Millisecond || d > 2*time.Second {
		t.Fatalf("unbind took %v", d)
	}
}

// With BusyStatus, a full set of slow handlers must not stop the read loop:
// extra requests are answered at once and responses keep flowing.
func TestBusyStatusKeepsReading(t *testing.T) {
	a, b := tcpPair(t)
	block := make(chan struct{})
	var once sync.Once
	release := func() { once.Do(func() { close(block) }) }
	defer release()
	// "us": slow handlers (receipts), but we also have our own requests in flight.
	us := New(a, Config{EnquireLinkInterval: -1, MaxInboundConcurrency: 1, BusyStatus: pdu.ESME_RX_T_APPN,
		Handler: func(s *Session, req pdu.PDU) { <-block; _ = s.Respond(pdu.NewResponse(req, pdu.ESME_ROK)) }})
	peer := New(b, Config{EnquireLinkInterval: -1, Handler: echoSubmitHandler(0)})
	us.Start()
	peer.Start()

	first := make(chan error, 1)
	go func() {
		_, err := peer.Request(context.Background(), &pdu.DeliverSM{})
		first <- err
	}()
	time.Sleep(50 * time.Millisecond) // the only handler slot is taken
	resp, err := peer.Request(context.Background(), &pdu.DeliverSM{})
	if err != nil || resp.Hdr().Status != pdu.ESME_RX_T_APPN {
		t.Fatalf("busy answer: %v %v", resp, err)
	}
	// Our own submit's response is read although the handler is stuck.
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	r, err := us.Request(ctx, &pdu.SubmitSM{ShortMessage: []byte("x")})
	if err != nil || r.(*pdu.SubmitSMResp).MessageID != "x" {
		t.Fatalf("submit_sm_resp not read while handlers are busy: %v", err)
	}
	release()
	if err := <-first; err != nil {
		t.Fatal(err)
	}
}

func TestErrNotSentOnlyBeforeWrite(t *testing.T) {
	a, b := tcpPair(t)
	srv := New(b, Config{EnquireLinkInterval: -1, Handler: func(s *Session, req pdu.PDU) {}}) // never answers
	cli := New(a, Config{EnquireLinkInterval: -1, RequestTimeout: 100 * time.Millisecond, WindowSize: 1})
	srv.Start()
	cli.Start()
	// Written, unanswered: outcome unknown.
	_, err := cli.Request(context.Background(), &pdu.SubmitSM{})
	if !errors.Is(err, ErrTimeout) || errors.Is(err, ErrNotSent) {
		t.Fatalf("timeout: %v", err)
	}
	// ctx already done: never written.
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := cli.Request(ctx, &pdu.SubmitSM{}); !errors.Is(err, ErrNotSent) || !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled: %v", err)
	}
	cli.Close()
	if _, err := cli.Request(context.Background(), &pdu.SubmitSM{}); !errors.Is(err, ErrNotSent) || !errors.Is(err, ErrClosed) {
		t.Fatalf("closed: %v", err)
	}
}
