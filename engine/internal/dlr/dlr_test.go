package dlr

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"

	"smsgw/engine/internal/cdr"
	"smsgw/engine/internal/pipeline"
	"smsgw/engine/internal/smpp/pdu"
	"smsgw/engine/internal/smpp/server"
	"smsgw/engine/internal/store"
	"smsgw/engine/internal/webhook"
)

func testRedis(t *testing.T) *redis.Client {
	t.Helper()
	u := os.Getenv("TEST_REDIS_URL")
	if u == "" {
		u = "redis://localhost:6399/2"
	}
	opt, _ := redis.ParseURL(u)
	rdb := redis.NewClient(opt)
	if err := rdb.Ping(context.Background()).Err(); err != nil {
		t.Fatalf("redis: %v", err)
	}
	t.Cleanup(func() { rdb.Close() })
	return rdb
}

type fakeSink struct {
	mu   sync.Mutex
	upds []cdr.Update
}

func (f *fakeSink) Insert(context.Context, cdr.Record) error { return nil }
func (f *fakeSink) Update(_ context.Context, u cdr.Update) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.upds = append(f.upds, u)
	return nil
}

func (f *fakeSink) last() cdr.Update {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.upds) == 0 {
		return cdr.Update{}
	}
	return f.upds[len(f.upds)-1]
}

func newMsg(t *testing.T, rdb *redis.Client, parts, pdus int) string {
	t.Helper()
	id := uuid.NewString()
	ctx := context.Background()
	rdb.HSet(ctx, pipeline.MsgKey(id), pipeline.FOrgID, "org1", pipeline.FChannel, "SMPP", pipeline.FParts, parts,
		pipeline.FDelivered, 0, pipeline.FFailed, 0, pipeline.FCreatedAtMS, time.Now().UnixMilli(),
		pipeline.FSMPPSystemID, "sys1", pipeline.FDest, "447700900123", pipeline.FSource, "ACME", pipeline.FRegDelivery, 1,
		pipeline.FText20, "hello", pipeline.FSubmittedMS, time.Now().UnixMilli())
	if pdus > 0 {
		rdb.HSet(ctx, pipeline.MsgKey(id), pipeline.FPDUs, pdus)
	}
	t.Cleanup(func() { rdb.Del(context.Background(), pipeline.MsgKey(id)) })
	return id
}

func TestRecordPartAggregation(t *testing.T) {
	rdb := testRedis(t)
	ctx := context.Background()

	id := newMsg(t, rdb, 3, 0)
	o, err := RecordPart(ctx, rdb, id, 0, cdr.StatusDelivered, "DELIVRD", "000")
	if err != nil || o.Kind != OutcomePartial || o.Delivered != 1 {
		t.Fatalf("%+v %v", o, err)
	}
	if o, _ := RecordPart(ctx, rdb, id, 0, cdr.StatusDelivered, "DELIVRD", "000"); o.Kind != OutcomeDup {
		t.Fatalf("dup: %+v", o)
	}
	if o, _ := RecordPart(ctx, rdb, id, 2, cdr.StatusExpired, "EXPIRED", "005"); o.Kind != OutcomePartial {
		t.Fatalf("%+v", o)
	}
	o, err = RecordPart(ctx, rdb, id, 1, cdr.StatusDelivered, "DELIVRD", "000")
	if err != nil || o.Kind != OutcomeFinal || o.Status != cdr.StatusExpired || o.DLRStat != "EXPIRED" || o.DLRErr != "005" || o.Delivered != 2 || o.Failed != 1 {
		t.Fatalf("final %+v %v", o, err)
	}
	if o, _ := RecordPart(ctx, rdb, id, 1, cdr.StatusDelivered, "DELIVRD", "000"); o.Kind != OutcomeDone {
		t.Fatalf("after final: %+v", o)
	}

	// All delivered → DELIVERED; pdus overrides parts (message_payload: one receipt).
	id2 := newMsg(t, rdb, 4, 1)
	o, _ = RecordPart(ctx, rdb, id2, 0, cdr.StatusDelivered, "DELIVRD", "000")
	if o.Kind != OutcomeFinal || o.Status != cdr.StatusDelivered {
		t.Fatalf("%+v", o)
	}
	// Worst wins: REJECTED beats UNDELIVERED.
	id3 := newMsg(t, rdb, 2, 2)
	RecordPart(ctx, rdb, id3, 0, cdr.StatusRejected, "REJECTD", "011")
	o, _ = RecordPart(ctx, rdb, id3, 1, cdr.StatusUndelivered, "UNDELIV", "001")
	if o.Status != cdr.StatusRejected || o.DLRErr != "011" {
		t.Fatalf("%+v", o)
	}
	if o, _ := RecordPart(ctx, rdb, uuid.NewString(), 0, cdr.StatusDelivered, "DELIVRD", ""); o.Kind != OutcomeNoMsg {
		t.Fatalf("%+v", o)
	}
	if _, err := RecordPart(ctx, rdb, id, 0, "BOGUS", "", ""); err == nil {
		t.Fatal("expected error")
	}
}

func TestStatMapping(t *testing.T) {
	for stat, want := range map[string]string{"DELIVRD": "DELIVERED", "UNDELIV": "UNDELIVERED", "EXPIRED": "EXPIRED",
		"REJECTD": "REJECTED", "DELETED": "UNKNOWN", "UNKNOWN": "UNKNOWN", "WEIRD": "UNKNOWN"} {
		if got, final := StatusForStat(stat); got != want || !final {
			t.Errorf("%s -> %s %v", stat, got, final)
		}
	}
	for _, s := range []string{"ACCEPTD", "ENROUTE", ""} {
		if _, final := StatusForStat(s); final {
			t.Errorf("%s final", s)
		}
	}
	if normalizeErr("") != "000" || normalizeErr("5") != "005" || normalizeErr("0011") != "011" {
		t.Fatal("normalizeErr")
	}
}

func receipt(id, stat string) *pdu.DeliverSM {
	r := pdu.Receipt{ID: id, Sub: 1, Dlvrd: 1, SubmitDate: time.Now(), DoneDate: time.Now(), Stat: stat, Err: "000", Text: "x"}
	return &pdu.DeliverSM{ESMClass: pdu.ESMClassMCDeliveryRcpt, ShortMessage: []byte(r.Format())}
}

func TestHandleDeliverEndToEnd(t *testing.T) {
	rdb := testRedis(t)
	ctx := context.Background()
	sink := &fakeSink{}
	stream := "test:dlr:" + uuid.NewString()
	t.Cleanup(func() { rdb.Del(context.Background(), stream) })
	p := NewProcessor(rdb, sink, nil, Options{Stream: stream, LookupWait: 2 * time.Second})
	conn := uuid.NewString()

	// Two-part message; SMSC ids hex in submit_sm_resp, decimal in the receipt.
	id := newMsg(t, rdb, 2, 2)
	created := time.Now().UnixMilli()
	k0 := pipeline.DLRMapKey(conn, pdu.NormalizeMessageID("00ff"))
	k1 := pipeline.DLRMapKey(conn, pdu.NormalizeMessageID("1a"))
	rdb.Set(ctx, k0, pipeline.DLRMapValue(id, 0, created), time.Minute)
	t.Cleanup(func() { rdb.Del(context.Background(), k0, k1) })

	// Not a receipt (MO) and an intermediate receipt are acknowledged and ignored.
	if st := p.HandleDeliver(conn, &pdu.DeliverSM{ShortMessage: []byte("hi")}); st != pdu.ESME_ROK {
		t.Fatal(st)
	}
	if st := p.HandleDeliver(conn, receipt("255", "ACCEPTD")); st != pdu.ESME_ROK || len(sink.upds) != 0 {
		t.Fatal("intermediate receipt changed state")
	}
	if st := p.HandleDeliver(conn, receipt("255", "DELIVRD")); st != pdu.ESME_ROK {
		t.Fatal(st)
	}
	if len(sink.upds) != 0 {
		t.Fatal("partial message must not update the CDR status")
	}
	// Second part: TLV-only receipt (no text) whose dlrmap entry appears late.
	go func() {
		time.Sleep(150 * time.Millisecond)
		rdb.Set(ctx, k1, pipeline.DLRMapValue(id, 1, created), time.Minute)
	}()
	d := &pdu.DeliverSM{ESMClass: pdu.ESMClassMCDeliveryRcpt}
	d.TLVs.SetReceiptedMessageID("1A")
	d.TLVs.SetMessageState(pdu.StateUndeliverable)
	if st := p.HandleDeliver(conn, d); st != pdu.ESME_ROK {
		t.Fatal(st)
	}
	u := sink.last()
	if u.ID != id || u.Status != cdr.StatusUndelivered || *u.DLRStat != "UNDELIV" || u.DLRReceivedAt == nil || u.CreatedAt.UnixMilli() != created {
		t.Fatalf("cdr update %+v", u)
	}
	msgs, _ := rdb.XRange(ctx, stream, "-", "+").Result()
	if len(msgs) != 1 {
		t.Fatalf("events %d", len(msgs))
	}
	var ev Event
	_ = json.Unmarshal([]byte(msgs[0].Values[EventField].(string)), &ev)
	if ev.MessageID != id || ev.Status != cdr.StatusUndelivered || ev.DLRStat != "UNDELIV" || ev.SMPPSystemID != "sys1" || ev.RegDelivery != 1 ||
		ev.To != "447700900123" || ev.From != "ACME" || ev.SubmittedAt == nil || ev.Parts != 2 {
		t.Fatalf("event %+v", ev)
	}
	// Unknown id: acknowledged (no DB fallback configured).
	if st := p.HandleDeliver(conn, receipt("deadbeef", "DELIVRD")); st != pdu.ESME_ROK {
		t.Fatal(st)
	}
}

func TestMessageFailedAndPartsFailed(t *testing.T) {
	rdb := testRedis(t)
	ctx := context.Background()
	sink := &fakeSink{}
	stream := "test:dlr:" + uuid.NewString()
	t.Cleanup(func() { rdb.Del(context.Background(), stream) })
	p := NewProcessor(rdb, sink, nil, Options{Stream: stream})

	id := newMsg(t, rdb, 1, 0)
	job := &pipeline.DispatchJob{ID: id, CreatedMS: time.Now().UnixMilli()}
	if err := p.MessageFailed(ctx, job, "ESME_RSUBMITFAIL", true); err != nil {
		t.Fatal(err)
	}
	if err := p.MessageFailed(ctx, job, "ESME_RSUBMITFAIL", true); err != nil { // idempotent
		t.Fatal(err)
	}
	if n := rdb.XLen(ctx, stream).Val(); n != 1 {
		t.Fatalf("events %d", n)
	}
	u := sink.last()
	if u.Status != cdr.StatusFailed || *u.ErrorCode != "ESME_RSUBMITFAIL" || u.Refunded == nil || !*u.Refunded {
		t.Fatalf("%+v", u)
	}

	// Part 1 of 2 rejected upstream; part 0 delivered later → FAILED overall.
	id2 := newMsg(t, rdb, 2, 2)
	job2 := &pipeline.DispatchJob{ID: id2, CreatedMS: time.Now().UnixMilli()}
	if err := p.PartsFailed(ctx, job2, []int{1}, "ESME_RTHROTTLED"); err != nil {
		t.Fatal(err)
	}
	o, _ := RecordPart(ctx, rdb, id2, 0, cdr.StatusDelivered, "DELIVRD", "000")
	if o.Kind != OutcomeFinal || o.Status != cdr.StatusFailed {
		t.Fatalf("%+v", o)
	}
}

type fakeSMPP struct {
	fails atomic.Int32 // fail this many times with ErrNoSession
	got   chan *pdu.DeliverSM
}

func (f *fakeSMPP) Deliver(_ context.Context, sys string, d *pdu.DeliverSM) (*pdu.DeliverSMResp, error) {
	if f.fails.Add(-1) >= 0 {
		return nil, server.ErrNoSession
	}
	f.got <- d
	return &pdu.DeliverSMResp{}, nil
}

type fakeHooks struct {
	mu   sync.Mutex
	jobs []webhook.Delivery
}

func (f *fakeHooks) Enqueue(_ context.Context, d webhook.Delivery) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, j := range f.jobs {
		if j.ID() == d.ID() {
			return nil
		}
	}
	f.jobs = append(f.jobs, d)
	return nil
}

type staticSnap struct{ s *store.Snapshot }

func (s staticSnap) Current() *store.Snapshot { return s.s }

func TestForwarderRetriesSMPPAndEnqueuesWebhooksOnce(t *testing.T) {
	rdb := testRedis(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	stream := "test:dlrout:" + uuid.NewString()
	t.Cleanup(func() { rdb.Del(context.Background(), stream) })
	smpp := &fakeSMPP{got: make(chan *pdu.DeliverSM, 1)}
	smpp.fails.Store(2)
	hooks := &fakeHooks{}
	snap := staticSnap{store.NewSnapshot(store.Data{Webhooks: []*store.Webhook{{ID: "wh1", OrgID: "org1", URL: "http://x", Secret: "s", Events: []string{"dlr"}, Enabled: true}}})}
	f := NewForwarder(rdb, snap, smpp, hooks, ForwarderOptions{Stream: stream, Consumer: "t", RetryIdle: 200 * time.Millisecond, Block: 50 * time.Millisecond})
	done := make(chan struct{})
	go func() { f.Run(ctx); close(done) }()

	now := time.Now().UTC()
	ev := Event{MessageID: uuid.NewString(), OrgID: "org1", Channel: "SMPP", SMPPSystemID: "sys1", RegDelivery: 1, To: "447700900123",
		From: "ACME", Status: cdr.StatusDelivered, DLRStat: "DELIVRD", DLRErr: "000", Parts: 1, Text: "Héllo wörld, this is long",
		CreatedAt: now.Add(-time.Minute), SubmittedAt: &now, DoneAt: now, EnqueuedAt: now}
	b, _ := json.Marshal(ev)
	rdb.XAdd(ctx, &redis.XAddArgs{Stream: stream, Values: []any{EventField, string(b)}})

	select {
	case d := <-smpp.got:
		r, ok := pdu.ReceiptFromDeliverSM(d)
		if !ok || r.ID != ev.MessageID || r.Stat != "DELIVRD" || r.Dlvrd != 1 || r.Sub != 1 || r.Text != "H?llo w?rld, this is" ||
			d.SourceAddr != ev.To || d.DestinationAddr != "ACME" || d.DestAddrTON != 5 {
			t.Fatalf("receipt %+v %q", r, d.ShortMessage)
		}
		if !strings.Contains(string(d.ShortMessage), "sub:001 dlvrd:001 submit date:") {
			t.Fatalf("text %q", d.ShortMessage)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("receipt never delivered")
	}
	// Acked and removed after success.
	deadline := time.Now().Add(5 * time.Second)
	for rdb.XLen(ctx, stream).Val() != 0 {
		if time.Now().After(deadline) {
			t.Fatal("event not acked")
		}
		time.Sleep(10 * time.Millisecond)
	}
	hooks.mu.Lock()
	n := len(hooks.jobs)
	var body WebhookBody
	if n > 0 {
		_ = json.Unmarshal(hooks.jobs[0].Body, &body)
	}
	hooks.mu.Unlock()
	if n != 1 || body.Status != "DELIVERED" || body.ClientRef != nil || body.Event != "dlr" {
		t.Fatalf("webhook jobs %d %+v", n, body)
	}
	cancel()
	<-done
}

func TestWantsReceipt(t *testing.T) {
	if wantsReceipt(0, "DELIVERED") || !wantsReceipt(1, "DELIVERED") || wantsReceipt(2, "DELIVERED") || !wantsReceipt(2, "FAILED") {
		t.Fatal("registered_delivery handling")
	}
}
