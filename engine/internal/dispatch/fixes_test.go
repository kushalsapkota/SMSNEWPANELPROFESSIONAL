package dispatch

import (
	"context"
	"errors"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"golang.org/x/time/rate"

	"smsgw/engine/internal/billing"
	"smsgw/engine/internal/cdr"
	"smsgw/engine/internal/pipeline"
	"smsgw/engine/internal/smpp/pdu"
	"smsgw/engine/internal/smpp/server"
	"smsgw/engine/internal/store"
)

func cleanupDLRMap(e *env, connID string, ids []string) {
	for _, id := range ids {
		e.rdb.Del(context.Background(), pipeline.DLRMapKey(connID, pdu.NormalizeMessageID(id)))
	}
}

// ESME_RTHROTTLED is flow control: the same PDU is resubmitted on the same
// connection (which slows down); the message is neither failed over nor
// failed and refunded.
func TestThrottledSubmitIsRetriedOnSameConnection(t *testing.T) {
	var throttles atomic.Int32
	throttles.Store(3)
	a := newSMSC(t, func(m *server.Message) pdu.CommandStatus {
		if throttles.Add(-1) >= 0 {
			return pdu.ESME_RTHROTTLED
		}
		return pdu.ESME_ROK
	})
	b := newSMSC(t, nil)
	route, ca, cb := uuid.NewString(), uuid.NewString(), uuid.NewString()
	e := newEnvWith(t, snapshot(route, []*store.Connection{conn(ca, a, ModeUDH), conn(cb, b, ModeUDH)}, []int{1, 2}), route, time.Minute,
		func(_ *env, o *Options) { o.ThrottleBackoff = 20 * time.Millisecond }, nil)
	e.waitBound(ca, cb)
	before := e.bal(e.client)
	job := e.enqueue("447700911111", "throttled", 1)
	var u *cdr.Update
	waitUntil(t, "submitted", func() bool { u = e.sink.find(job.ID, cdr.StatusSubmitted); return u != nil })
	defer cleanupDLRMap(e, ca, u.SMSCMsgIDs)
	if u.ConnectionID != ca || a.count("447700911111") != 4 || b.count("447700911111") != 0 {
		t.Fatalf("conn %s, attempts on A %d, on B %d", u.ConnectionID, a.count("447700911111"), b.count("447700911111"))
	}
	if _, failed := e.fin.failure(job.ID); failed || e.bal(e.client) != before-100 {
		t.Fatalf("throttled message failed or refunded (balance %d, before %d)", e.bal(e.client), before)
	}
	if lim := e.m.conn(ca).limiter.Limit(); lim >= rate.Limit(500) {
		t.Fatalf("connection rate not reduced after throttling: %v", lim)
	}
}

// A submit_sm_resp timeout means the SMSC may have the message: it must not
// be resent on another connection, nor refunded.
func TestSubmitTimeoutDoesNotFailOverOrRefund(t *testing.T) {
	a := newSMSC(t, func(m *server.Message) pdu.CommandStatus {
		time.Sleep(700 * time.Millisecond) // answers after our timeout
		return pdu.ESME_ROK
	})
	b := newSMSC(t, nil)
	route, ca, cb := uuid.NewString(), uuid.NewString(), uuid.NewString()
	slow := conn(ca, a, ModeUDH)
	slow.SubmitTimeout = 300 * time.Millisecond
	e := newEnv(t, snapshot(route, []*store.Connection{slow, conn(cb, b, ModeUDH)}, []int{1, 2}), route, time.Minute)
	e.waitBound(ca, cb)
	before := e.bal(e.client)
	job := e.enqueue("447700922222", "maybe delivered", 1)
	waitUntil(t, "unknown outcome recorded", func() bool { return len(e.fin.unknown(job.ID)) == 1 })
	time.Sleep(200 * time.Millisecond)
	if b.count("447700922222") != 0 {
		t.Fatal("message resent on another connection after a timeout (duplicate SMS)")
	}
	if a.count("447700922222") != 1 {
		t.Fatalf("attempts on A: %d", a.count("447700922222"))
	}
	if _, failed := e.fin.failure(job.ID); failed || e.bal(e.client) != before-100 {
		t.Fatalf("timed-out message failed/refunded (balance %d, before %d)", e.bal(e.client), before)
	}
	u := e.sink.find(job.ID, cdr.StatusSubmitted)
	if u == nil || u.ConnectionID != ca || u.ErrorCode == nil || *u.ErrorCode != "SUBMIT_TIMEOUT" {
		t.Fatalf("cdr %+v", u)
	}
	waitUntil(t, "acked", func() bool { return e.rdb.XLen(context.Background(), pipeline.DispatchStream(route)).Val() == 0 })
}

// Each part's dlrmap entry exists as soon as its submit_sm_resp arrives, so
// a fast receipt for part 1 matches while later parts are still in flight.
func TestDLRMapWrittenPerPartBeforeLastPart(t *testing.T) {
	var route, ca string
	var e *env
	seenEarly := make(chan bool, 1)
	a := newSMSC(t, func(m *server.Message) pdu.CommandStatus {
		// Called when the LAST part arrives (the fake SMSC acks earlier
		// parts at once): part 0 must already be mapped.
		keys, _ := e.rdb.Keys(context.Background(), "dlrmap:"+ca+":*").Result()
		ok := false
		for _, k := range keys {
			if v, _ := e.rdb.Get(context.Background(), k).Result(); strings.Contains(v, "|0|") {
				ok = true
			}
		}
		seenEarly <- ok
		return pdu.ESME_ROK
	})
	route, ca = uuid.NewString(), uuid.NewString()
	e = newEnv(t, snapshot(route, []*store.Connection{conn(ca, a, ModeUDH)}, []int{1}), route, time.Minute)
	e.waitBound(ca)
	job := e.enqueue("447700933333", strings.Repeat("z", 300), 2)
	select {
	case ok := <-seenEarly:
		if !ok {
			t.Fatal("part 0 had no dlrmap entry while part 1 was being submitted")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("never submitted")
	}
	var u *cdr.Update
	waitUntil(t, "submitted", func() bool { u = e.sink.find(job.ID, cdr.StatusSubmitted); return u != nil })
	cleanupDLRMap(e, ca, u.SMSCMsgIDs)
	// The PDU count was recorded before sending (a receipt can arrive first).
	if v, _ := e.rdb.HGet(context.Background(), pipeline.MsgKey(job.ID), pipeline.FPDUs).Result(); v != "2" {
		t.Fatalf("pdus %q", v)
	}
}

// An SMSC returning the same message_id for every part gets one dlrmap
// entry listing all parts (not one entry overwritten by the last part).
func TestSharedSMSCIDMapsAllParts(t *testing.T) {
	a := newSMSCWith(t, nil, false)
	route, ca := uuid.NewString(), uuid.NewString()
	e := newEnv(t, snapshot(route, []*store.Connection{conn(ca, a, ModeUDH)}, []int{1}), route, time.Minute)
	e.waitBound(ca)
	job := e.enqueue("447700944444", strings.Repeat("q", 300), 2)
	var u *cdr.Update
	waitUntil(t, "submitted", func() bool { u = e.sink.find(job.ID, cdr.StatusSubmitted); return u != nil })
	defer cleanupDLRMap(e, ca, u.SMSCMsgIDs)
	if len(u.SMSCMsgIDs) != 2 || u.SMSCMsgIDs[0] != u.SMSCMsgIDs[1] {
		t.Fatalf("expected one shared id, got %v", u.SMSCMsgIDs)
	}
	v, err := e.rdb.Get(context.Background(), pipeline.DLRMapKey(ca, pdu.NormalizeMessageID(u.SMSCMsgIDs[0]))).Result()
	if err != nil || v != pipeline.DLRMapValueParts(job.ID, []int{0, 1}, job.CreatedMS) {
		t.Fatalf("dlrmap %q %v", v, err)
	}
}

// Changing max_tps (or other per-message fields) applies in place: the
// sessions are not unbound and rebound.
func TestMaxTPSChangeDoesNotRebind(t *testing.T) {
	a := newSMSC(t, nil)
	route, ca := uuid.NewString(), uuid.NewString()
	c := conn(ca, a, ModeUDH)
	e := newEnv(t, snapshot(route, []*store.Connection{c}, []int{1}), route, time.Minute)
	e.waitBound(ca)
	u := e.m.conn(ca)
	sessions := map[string]bool{}
	for _, s := range a.srv.Sessions() {
		sessions[s.ID] = true
	}
	changed := *c
	changed.MaxTPS, changed.Name, changed.MultipartMode, changed.RequestDLR = 40, "renamed", ModeSAR, false
	e.src.set(snapshot(route, []*store.Connection{&changed}, []int{1}))
	waitUntil(t, "max_tps applied", func() bool { return u.limiter.Limit() == rate.Limit(40) })
	time.Sleep(200 * time.Millisecond)
	if e.m.conn(ca) != u {
		t.Fatal("connection was replaced (rebind)")
	}
	for _, s := range a.srv.Sessions() {
		if !sessions[s.ID] {
			t.Fatalf("new session %s: rebound", s.ID)
		}
	}
	if len(a.srv.Sessions()) != len(sessions) {
		t.Fatal("sessions changed")
	}
	// A session-relevant change still rebinds.
	moved := changed
	moved.WindowSize = 3
	e.src.set(snapshot(route, []*store.Connection{&moved}, []int{1}))
	waitUntil(t, "rebound", func() bool { return e.m.conn(ca) != u })
}

// A message whose submission had started on a crashed instance is never
// resent (its parts may be at the SMSC) and not refunded.
func TestInterruptedSubmissionNotResent(t *testing.T) {
	a := newSMSC(t, nil)
	route, ca := uuid.NewString(), uuid.NewString()
	e := newEnv(t, snapshot(route, []*store.Connection{conn(ca, a, ModeUDH)}, []int{1}), route, 300*time.Millisecond)
	e.waitBound(ca)
	e.cancel()
	<-e.done
	job := e.enqueue("447700955555", "was in flight", 1)
	ctx := context.Background()
	e.rdb.HSet(ctx, pipeline.MsgKey(job.ID), pipeline.FSubmitting, time.Now().UnixMilli(), pipeline.FConnection, ca, pipeline.FPDUs, 1)
	before := e.bal(e.client)
	e2 := newEnv(t, snapshot(route, []*store.Connection{conn(ca, a, ModeUDH)}, []int{1}), route, 300*time.Millisecond)
	waitUntil(t, "finalized as unknown", func() bool { return len(e2.fin.unknown(job.ID)) == 1 })
	if a.count("447700955555") != 0 {
		t.Fatal("interrupted message was sent again")
	}
	if e.bal(e.client) != before {
		t.Fatal("interrupted message refunded")
	}
}

// flakyBiller fails the first n refunds with a transport error.
type flakyBiller struct {
	pipeline.Biller
	fail atomic.Int32
}

func (f *flakyBiller) Refund(ctx context.Context, txn string, legs []billing.Leg, amounts []int64) (billing.RefundResult, error) {
	if f.fail.Add(-1) >= 0 {
		return billing.RefundResult{}, errors.New("redis: i/o timeout")
	}
	return f.Biller.Refund(ctx, txn, legs, amounts)
}

// A refund that fails is not reported as refunded; it is queued and the
// retry applies it (and then flips the CDR flag).
func TestFailedRefundNotMarkedRefundedAndRetried(t *testing.T) {
	a := newSMSC(t, rejectSuffix("6666"))
	route, ca := uuid.NewString(), uuid.NewString()
	refundKey := "test:refund:" + uuid.NewString()
	var fb *flakyBiller
	e := newEnvWith(t, snapshot(route, []*store.Connection{conn(ca, a, ModeUDH)}, []int{1}), route, time.Minute,
		func(e *env, o *Options) {
			// The Manager's refunder uses the flaky biller and a test-only pending list.
			o.Refunder = pipeline.NewRefunder(fb, e.rdb, e.sink, pipeline.RefunderOptions{Key: refundKey, Logger: quiet})
		},
		func(b pipeline.Biller) pipeline.Biller {
			fb = &flakyBiller{Biller: b}
			fb.fail.Store(1)
			return fb
		})
	t.Cleanup(func() { e.rdb.Del(context.Background(), refundKey) })
	e.waitBound(ca)
	before := e.bal(e.client)
	job := e.enqueue("447700966666", "rejected", 1)
	waitUntil(t, "failed", func() bool { _, ok := e.fin.failure(job.ID); return ok })
	e.fin.mu.Lock()
	refunded := e.fin.refunded[job.ID]
	e.fin.mu.Unlock()
	if refunded {
		t.Fatal("refund failed but the message is reported refunded")
	}
	if e.bal(e.client) != before-100 {
		t.Fatal("refund unexpectedly applied")
	}
	if n := e.rdb.LLen(context.Background(), refundKey).Val(); n != 1 {
		t.Fatalf("pending refunds %d", n)
	}
	e.m.opts.Refunder.RetryPending(context.Background())
	if e.bal(e.client) != before || e.rdb.LLen(context.Background(), refundKey).Val() != 0 {
		t.Fatalf("retry did not refund: %d (before %d)", e.bal(e.client), before)
	}
	e.sink.mu.Lock()
	var flagged bool
	for _, u := range e.sink.upds {
		if u.ID == job.ID && u.Refunded != nil && *u.Refunded {
			flagged = true
		}
	}
	e.sink.mu.Unlock()
	if !flagged {
		t.Fatal("CDR not flagged refunded after the retry")
	}
}
