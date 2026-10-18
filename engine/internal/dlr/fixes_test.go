package dlr

import (
	"context"
	"encoding/json"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"

	"smsgw/engine/internal/cdr"
	"smsgw/engine/internal/pipeline"
	"smsgw/engine/internal/smpp/pdu"
	"smsgw/engine/internal/smpp/server"
	"smsgw/engine/internal/store"
)

func events(t *testing.T, rdb *redis.Client, stream string) []Event {
	t.Helper()
	msgs, err := rdb.XRange(context.Background(), stream, "-", "+").Result()
	if err != nil {
		t.Fatal(err)
	}
	var out []Event
	for _, m := range msgs {
		var ev Event
		_ = json.Unmarshal([]byte(m.Values[EventField].(string)), &ev)
		out = append(out, ev)
	}
	return out
}

// While a receipt's own dlrmap entry is still being written, the hex /
// decimal variant of its id must not match another message.
func TestLookupPrefersExactIDOverVariant(t *testing.T) {
	rdb := testRedis(t)
	ctx := context.Background()
	stream := "test:dlr:" + uuid.NewString()
	t.Cleanup(func() { rdb.Del(context.Background(), stream) })
	p := NewProcessor(rdb, &fakeSink{}, nil, Options{Stream: stream, LookupWait: 2 * time.Second})
	conn := uuid.NewString()
	other := newMsg(t, rdb, 1, 1) // its SMSC id was "10" (hex of 16)
	mine := newMsg(t, rdb, 1, 1)  // its SMSC id is "16", entry written late
	created := time.Now().UnixMilli()
	kOther, kMine := pipeline.DLRMapKey(conn, "10"), pipeline.DLRMapKey(conn, "16")
	rdb.Set(ctx, kOther, pipeline.DLRMapValue(other, 0, created), time.Minute)
	t.Cleanup(func() { rdb.Del(context.Background(), kOther, kMine) })
	go func() {
		time.Sleep(200 * time.Millisecond)
		rdb.Set(ctx, kMine, pipeline.DLRMapValue(mine, 0, created), time.Minute)
	}()
	if st := p.HandleDeliver(conn, receipt("16", "DELIVRD")); st != pdu.ESME_ROK {
		t.Fatal(st)
	}
	evs := events(t, rdb, stream)
	if len(evs) != 1 || evs[0].MessageID != mine {
		t.Fatalf("receipt matched %v, want %s (not %s)", evs, mine, other)
	}
	if v, _ := rdb.HGet(ctx, pipeline.MsgKey(other), "done").Result(); v != "" {
		t.Fatal("the other message was finalized")
	}
}

// A connection whose receipts use a converted id form is learned, so later
// receipts do not wait for an exact key that never comes.
func TestLookupLearnsConvertedIDForm(t *testing.T) {
	rdb := testRedis(t)
	ctx := context.Background()
	stream := "test:dlr:" + uuid.NewString()
	t.Cleanup(func() { rdb.Del(context.Background(), stream) })
	p := NewProcessor(rdb, &fakeSink{}, nil, Options{Stream: stream, LookupWait: 500 * time.Millisecond})
	conn := uuid.NewString()
	for i, pair := range [][2]string{{"ff", "255"}, {"100", "256"}} {
		id := newMsg(t, rdb, 1, 1)
		k := pipeline.DLRMapKey(conn, pair[0]) // submit_sm_resp: hex
		rdb.Set(ctx, k, pipeline.DLRMapValue(id, 0, time.Now().UnixMilli()), time.Minute)
		t.Cleanup(func() { rdb.Del(context.Background(), k) })
		start := time.Now()
		if st := p.HandleDeliver(conn, receipt(pair[1], "DELIVRD")); st != pdu.ESME_ROK { // receipt: decimal
			t.Fatal(st)
		}
		if i == 1 && time.Since(start) > 300*time.Millisecond {
			t.Fatalf("second receipt waited %v: id form not learned", time.Since(start))
		}
	}
	if n := len(events(t, rdb, stream)); n != 2 {
		t.Fatalf("events %d", n)
	}
}

// One receipt for an id shared by every part finalizes the message.
func TestSharedIDReceiptCompletesAllParts(t *testing.T) {
	rdb := testRedis(t)
	ctx := context.Background()
	stream := "test:dlr:" + uuid.NewString()
	t.Cleanup(func() { rdb.Del(context.Background(), stream) })
	sink := &fakeSink{}
	p := NewProcessor(rdb, sink, nil, Options{Stream: stream})
	conn := uuid.NewString()
	id := newMsg(t, rdb, 3, 3)
	k := pipeline.DLRMapKey(conn, "abc")
	rdb.Set(ctx, k, pipeline.DLRMapValueParts(id, []int{0, 1, 2}, time.Now().UnixMilli()), time.Minute)
	t.Cleanup(func() { rdb.Del(context.Background(), k) })
	if st := p.HandleDeliver(conn, receipt("ABC", "DELIVRD")); st != pdu.ESME_ROK {
		t.Fatal(st)
	}
	if u := sink.last(); u.ID != id || u.Status != cdr.StatusDelivered {
		t.Fatalf("not finalized: %+v", u)
	}
	// A second receipt for the same id is a duplicate.
	if st := p.HandleDeliver(conn, receipt("ABC", "DELIVRD")); st != pdu.ESME_ROK || len(events(t, rdb, stream)) != 1 {
		t.Fatal("duplicate receipt emitted twice")
	}
}

// A replay of the call that produced FINAL (go-redis retry after a lost
// reply) gets FINAL again; other callers get DONE unless the finalizer
// released its claim or never marked the event emitted.
func TestRecordPartReplayAndRelease(t *testing.T) {
	rdb := testRedis(t)
	ctx := context.Background()
	id := newMsg(t, rdb, 1, 1)
	now := time.Now()
	o, err := recordPart(ctx, rdb, id, 0, cdr.StatusDelivered, "DELIVRD", "000", "tok-1", now)
	if err != nil || o.Kind != OutcomeFinal {
		t.Fatalf("%+v %v", o, err)
	}
	if o, _ := recordPart(ctx, rdb, id, 0, cdr.StatusDelivered, "DELIVRD", "000", "tok-1", now); o.Kind != OutcomeFinal || o.Status != cdr.StatusDelivered || o.DLRStat != "DELIVRD" {
		t.Fatalf("replay: %+v", o)
	}
	if o, _ := recordPart(ctx, rdb, id, 0, cdr.StatusDelivered, "DELIVRD", "000", "tok-2", now); o.Kind != OutcomeDone {
		t.Fatalf("other caller while claimed: %+v", o)
	}
	// The finalizer failed and released: a redelivered receipt takes over.
	if err := ReleaseFinal(ctx, rdb, id); err != nil {
		t.Fatal(err)
	}
	if o, _ := recordPart(ctx, rdb, id, 0, cdr.StatusDelivered, "DELIVRD", "000", "tok-3", now); o.Kind != OutcomeFinal {
		t.Fatalf("after release: %+v", o)
	}
	if err := MarkEmitted(ctx, rdb, id); err != nil {
		t.Fatal(err)
	}
	if o, _ := recordPart(ctx, rdb, id, 0, cdr.StatusDelivered, "DELIVRD", "000", "tok-3", now.Add(time.Hour)); o.Kind != OutcomeDone {
		t.Fatalf("after emitted: %+v", o)
	}
	// A crashed finalizer's stale claim is taken over after 30s.
	id2 := newMsg(t, rdb, 1, 1)
	recordPart(ctx, rdb, id2, 0, cdr.StatusExpired, "EXPIRED", "001", "a", now)
	if o, _ := recordPart(ctx, rdb, id2, 0, cdr.StatusExpired, "EXPIRED", "001", "b", now.Add(31*time.Second)); o.Kind != OutcomeFinal || o.Status != cdr.StatusExpired {
		t.Fatalf("stale claim: %+v", o)
	}
}

// done_at is the engine's receive time, not the SMSC's local "done date".
func TestDoneAtIsEngineTime(t *testing.T) {
	rdb := testRedis(t)
	ctx := context.Background()
	stream := "test:dlr:" + uuid.NewString()
	t.Cleanup(func() { rdb.Del(context.Background(), stream) })
	fixed := time.Date(2026, 10, 18, 10, 14, 33, 0, time.UTC)
	p := NewProcessor(rdb, &fakeSink{}, nil, Options{Stream: stream, Now: func() time.Time { return fixed }})
	conn := uuid.NewString()
	id := newMsg(t, rdb, 1, 1)
	k := pipeline.DLRMapKey(conn, "77")
	rdb.Set(ctx, k, pipeline.DLRMapValue(id, 0, fixed.UnixMilli()), time.Minute)
	t.Cleanup(func() { rdb.Del(context.Background(), k) })
	r := pdu.Receipt{ID: "77", Sub: 1, Dlvrd: 1, SubmitDate: fixed, DoneDate: fixed.Add(2 * time.Hour), Stat: "DELIVRD", Err: "000"}
	if st := p.HandleDeliver(conn, &pdu.DeliverSM{ESMClass: pdu.ESMClassMCDeliveryRcpt, ShortMessage: []byte(r.Format())}); st != pdu.ESME_ROK {
		t.Fatal(st)
	}
	evs := events(t, rdb, stream)
	if len(evs) != 1 || !evs[0].DoneAt.Equal(fixed) {
		t.Fatalf("done_at %v, want %v", evs, fixed)
	}
}

func TestPartsUnknownFinalizesUnknown(t *testing.T) {
	rdb := testRedis(t)
	stream := "test:dlr:" + uuid.NewString()
	t.Cleanup(func() { rdb.Del(context.Background(), stream) })
	sink := &fakeSink{}
	p := NewProcessor(rdb, sink, nil, Options{Stream: stream})
	id := newMsg(t, rdb, 1, 1)
	if err := p.PartsUnknown(context.Background(), &pipeline.DispatchJob{ID: id, CreatedMS: time.Now().UnixMilli()}, []int{0}, "SUBMIT_TIMEOUT"); err != nil {
		t.Fatal(err)
	}
	if u := sink.last(); u.Status != cdr.StatusUnknown {
		t.Fatalf("%+v", u)
	}
	if evs := events(t, rdb, stream); len(evs) != 1 || evs[0].Status != cdr.StatusUnknown {
		t.Fatalf("%+v", evs)
	}
}

// --- forwarder ---------------------------------------------------------------

type recSMPP struct {
	mu        sync.Mutex
	receivers map[server.ReceiverKey]bool
	got       chan string // "org/sys/message id"
}

func newRecSMPP(keys ...server.ReceiverKey) *recSMPP {
	r := &recSMPP{receivers: map[server.ReceiverKey]bool{}, got: make(chan string, 10)}
	for _, k := range keys {
		r.receivers[k] = true
	}
	return r
}

func (r *recSMPP) DeliverTo(_ context.Context, org, sys string, d *pdu.DeliverSM) (*pdu.DeliverSMResp, error) {
	if !r.HasReceiverFor(org, sys) {
		return nil, server.ErrNoSession
	}
	id, _ := d.TLVs.ReceiptedMessageID()
	r.got <- org + "/" + sys + "/" + id
	return &pdu.DeliverSMResp{}, nil
}

func (r *recSMPP) HasReceiverFor(org, sys string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.receivers[server.ReceiverKey{OrgID: org, SystemID: sys}]
}

func (r *recSMPP) Receivers() []server.ReceiverKey {
	r.mu.Lock()
	defer r.mu.Unlock()
	var out []server.ReceiverKey
	for k := range r.receivers {
		out = append(out, k)
	}
	return out
}

func addEvent(t *testing.T, rdb *redis.Client, stream, org, sys string) Event {
	t.Helper()
	now := time.Now().UTC()
	ev := Event{MessageID: uuid.NewString(), OrgID: org, Channel: "SMPP", SMPPSystemID: sys, RegDelivery: 1, To: "447700900123",
		From: "ACME", Status: cdr.StatusDelivered, DLRStat: "DELIVRD", DLRErr: "000", Parts: 1, CreatedAt: now, DoneAt: now, EnqueuedAt: now}
	b, _ := json.Marshal(ev)
	if err := rdb.XAdd(context.Background(), &redis.XAddArgs{Stream: stream, Values: []any{EventField, string(b)}}).Err(); err != nil {
		t.Fatal(err)
	}
	return ev
}

func runForwarder(t *testing.T, f *Forwarder) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { f.Run(ctx); close(done) }()
	t.Cleanup(func() { cancel(); <-done })
}

// A receipt for a system_id that now belongs to another organization (the
// account was deleted and re-created) is dropped, never delivered.
func TestForwarderDropsReceiptForReassignedSystemID(t *testing.T) {
	rdb := testRedis(t)
	stream := "test:dlrout:" + uuid.NewString()
	t.Cleanup(func() { rdb.Del(context.Background(), stream, stream+":instances") })
	sys := "acme" + uuid.NewString()[:4]
	smpp := newRecSMPP(server.ReceiverKey{OrgID: "org-b", SystemID: sys})
	snap := staticSnap{store.NewSnapshot(store.Data{SMPPAccounts: []*store.SMPPAccount{{ID: "a2", OrgID: "org-b", SystemID: sys, Enabled: true}}})}
	f := NewForwarder(rdb, snap, smpp, nil, ForwarderOptions{Stream: stream, Consumer: "i1", RetryIdle: 200 * time.Millisecond, Block: 50 * time.Millisecond})
	runForwarder(t, f)
	addEvent(t, rdb, stream, "org-a", sys) // receipt of the old owner
	deadline := time.Now().Add(5 * time.Second)
	for rdb.XLen(context.Background(), stream).Val() != 0 {
		if time.Now().After(deadline) {
			t.Fatal("event not acked")
		}
		time.Sleep(10 * time.Millisecond)
	}
	select {
	case got := <-smpp.got:
		t.Fatalf("receipt leaked to the new owner: %s", got)
	case <-time.After(300 * time.Millisecond):
	}
}

// A receipt read by an instance without the client's session is handed to
// the instance that holds it.
func TestForwarderRoutesToInstanceHoldingSession(t *testing.T) {
	rdb := testRedis(t)
	stream := "test:dlrout:" + uuid.NewString()
	sys := "rt" + uuid.NewString()[:6]
	t.Cleanup(func() {
		rdb.Del(context.Background(), stream, stream+":i:A", stream+":i:B", stream+":instances", RegistryKey(sys))
	})
	snap := staticSnap{store.NewSnapshot(store.Data{SMPPAccounts: []*store.SMPPAccount{{ID: "a1", OrgID: "org1", SystemID: sys, Enabled: true}}})}
	opts := func(inst string) ForwarderOptions {
		return ForwarderOptions{Stream: stream, Consumer: inst, RetryIdle: 200 * time.Millisecond, Block: 50 * time.Millisecond, RegistryTTL: 3 * time.Second}
	}
	smppB := newRecSMPP(server.ReceiverKey{OrgID: "org1", SystemID: sys})
	fB := NewForwarder(rdb, snap, smppB, nil, opts("B"))
	fB.publishReceivers(context.Background()) // B advertised its receiver (but is not consuming yet)

	smppA := newRecSMPP()
	runForwarder(t, NewForwarder(rdb, snap, smppA, nil, opts("A")))
	ev := addEvent(t, rdb, stream, "org1", sys)
	deadline := time.Now().Add(5 * time.Second)
	for rdb.XLen(context.Background(), stream+":i:B").Val() != 1 {
		if time.Now().After(deadline) {
			t.Fatal("receipt not handed to instance B")
		}
		time.Sleep(10 * time.Millisecond)
	}
	runForwarder(t, fB)
	select {
	case got := <-smppB.got:
		if got != "org1/"+sys+"/"+ev.MessageID {
			t.Fatal(got)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("instance B never delivered the receipt")
	}
}

// The stream of an instance that stopped heart-beating is moved back to the
// shared stream and delivered by whoever holds the session.
func TestForwarderRecoversDeadInstanceStream(t *testing.T) {
	rdb := testRedis(t)
	ctx := context.Background()
	stream := "test:dlrout:" + uuid.NewString()
	sys := "dd" + uuid.NewString()[:6]
	t.Cleanup(func() {
		rdb.Del(context.Background(), stream, stream+":i:dead", stream+":i:A", stream+":instances", RegistryKey(sys))
	})
	ev := addEvent(t, rdb, stream+":i:dead", "org1", sys)
	rdb.HSet(ctx, stream+":instances", "dead", time.Now().Add(-time.Hour).UnixMilli())
	snap := staticSnap{store.NewSnapshot(store.Data{SMPPAccounts: []*store.SMPPAccount{{ID: "a1", OrgID: "org1", SystemID: sys, Enabled: true}}})}
	smpp := newRecSMPP(server.ReceiverKey{OrgID: "org1", SystemID: sys})
	runForwarder(t, NewForwarder(rdb, snap, smpp, nil, ForwarderOptions{Stream: stream, Consumer: "A", RetryIdle: 200 * time.Millisecond,
		Block: 50 * time.Millisecond, RegistryTTL: 300 * time.Millisecond}))
	select {
	case got := <-smpp.got:
		if got != "org1/"+sys+"/"+ev.MessageID {
			t.Fatal(got)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("dead instance's receipt never delivered")
	}
	if rdb.Exists(ctx, stream+":i:dead").Val() != 0 {
		t.Fatal("dead instance stream not removed")
	}
}

// Receipts for an offline client stay pending without delaying others.
func TestForwarderOfflineBacklogDoesNotBlockNewEvents(t *testing.T) {
	rdb := testRedis(t)
	stream := "test:dlrout:" + uuid.NewString()
	t.Cleanup(func() { rdb.Del(context.Background(), stream, stream+":i:A", stream+":instances") })
	snap := staticSnap{store.NewSnapshot(store.Data{SMPPAccounts: []*store.SMPPAccount{
		{ID: "a1", OrgID: "org1", SystemID: "offline", Enabled: true}, {ID: "a2", OrgID: "org1", SystemID: "online", Enabled: true}}})}
	smpp := newRecSMPP(server.ReceiverKey{OrgID: "org1", SystemID: "online"})
	for i := 0; i < 300; i++ {
		addEvent(t, rdb, stream, "org1", "offline")
	}
	runForwarder(t, NewForwarder(rdb, snap, smpp, nil, ForwarderOptions{Stream: stream, Consumer: "A", RetryIdle: 100 * time.Millisecond,
		Block: 20 * time.Millisecond, ReclaimMax: 50}))
	time.Sleep(400 * time.Millisecond) // backlog pending and being reclaimed
	ev := addEvent(t, rdb, stream, "org1", "online")
	start := time.Now()
	select {
	case got := <-smpp.got:
		if got != "org1/online/"+ev.MessageID {
			t.Fatal(got)
		}
		if time.Since(start) > 2*time.Second {
			t.Fatalf("new receipt delayed %v by the offline backlog", time.Since(start))
		}
	case <-time.After(5 * time.Second):
		t.Fatal("new receipt not delivered")
	}
}

// The message_logs fallback prefers the row whose stored id is the receipt
// id itself over a newer row matching only a hex/decimal variant.
func TestFallbackPrefersExactID(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		dsn = "postgres://sms_engine_login:sms_engine_dev@localhost:5432/sms_flow"
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if err := pool.Ping(ctx); err != nil {
		t.Fatalf("postgres: %v", err)
	}
	org, conn := uuid.NewString(), uuid.NewString()
	t.Cleanup(func() { pool.Exec(context.Background(), `DELETE FROM message_logs WHERE org_id = $1`, org) })
	exact, variant := uuid.NewString(), uuid.NewString()
	now := time.Now().UTC().Truncate(time.Millisecond)
	ins := `INSERT INTO message_logs (id, created_at, org_id, connection_id, channel, destination_addr, orig_text, status, smsc_msg_ids)
	        VALUES ($1, $2, $3, $4, 'HTTP', '447700900123', 'x', 'SUBMITTED', $5)`
	if _, err := pool.Exec(ctx, ins, exact, now.Add(-time.Minute), org, conn, []string{"16"}); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, ins, variant, now, org, conn, []string{"10"}); err != nil { // newer, hex of 16
		t.Fatal(err)
	}
	rdb := testRedis(t)
	sink := &fakeSink{}
	p := NewProcessor(rdb, sink, pool, Options{LookupWait: 20 * time.Millisecond})
	if st := p.HandleDeliver(conn, receipt("16", "DELIVRD")); st != pdu.ESME_ROK {
		t.Fatal(st)
	}
	if u := sink.last(); u.ID != exact || u.Status != cdr.StatusDelivered {
		t.Fatalf("fallback matched %s, want %s", u.ID, exact)
	}
}
