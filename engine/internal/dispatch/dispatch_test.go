package dispatch

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"

	"smsgw/engine/internal/billing"
	"smsgw/engine/internal/cdr"
	"smsgw/engine/internal/pipeline"
	"smsgw/engine/internal/smpp/coding"
	"smsgw/engine/internal/smpp/pdu"
	"smsgw/engine/internal/smpp/server"
	"smsgw/engine/internal/store"
)

var quiet = slog.New(slog.NewTextHandler(io.Discard, nil))

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

// --- fake upstream SMSC ------------------------------------------------------

type fakeSMSC struct {
	srv    *server.Server
	host   string
	port   int
	seq    atomic.Uint64
	reject func(m *server.Message) pdu.CommandStatus
	mu     sync.Mutex
	msgs   []*server.Message
}

func (f *fakeSMSC) NewMessageID() string { return strconv.FormatUint(0xA000+f.seq.Add(1), 16) }

func (f *fakeSMSC) HandleMessage(_ context.Context, m *server.Message) pdu.CommandStatus {
	f.mu.Lock()
	f.msgs = append(f.msgs, m)
	f.mu.Unlock()
	if f.reject != nil {
		return f.reject(m)
	}
	return pdu.ESME_ROK
}

func (f *fakeSMSC) count(dest string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for _, m := range f.msgs {
		if m.DestAddr == dest {
			n++
		}
	}
	return n
}

func (f *fakeSMSC) get(dest string) *server.Message {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, m := range f.msgs {
		if m.DestAddr == dest {
			return m
		}
	}
	return nil
}

func rejectSuffix(sfx string) func(*server.Message) pdu.CommandStatus {
	return func(m *server.Message) pdu.CommandStatus {
		if strings.HasSuffix(m.DestAddr, sfx) {
			return pdu.ESME_RSUBMITFAIL
		}
		return pdu.ESME_ROK
	}
}

func newSMSC(t *testing.T, reject func(*server.Message) pdu.CommandStatus) *fakeSMSC {
	t.Helper()
	f := &fakeSMSC{reject: reject}
	srv, err := server.New(server.Config{
		Authenticator: server.AuthenticatorFunc(func(_ context.Context, r *server.BindRequest) (*server.Identity, pdu.CommandStatus) {
			return &server.Identity{OrgID: "up", SystemID: r.SystemID}, pdu.ESME_ROK
		}),
		Handler: f, PerPartMessageIDs: true, Logger: quiet, EnquireLinkInterval: -1,
	})
	if err != nil {
		t.Fatal(err)
	}
	addr, err := srv.Listen("127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	f.srv = srv
	f.host, f.port = "127.0.0.1", addr.(*net.TCPAddr).Port
	t.Cleanup(func() { srv.Close() })
	return f
}

// --- fakes -------------------------------------------------------------------

type fakeSource struct {
	mu   sync.Mutex
	snap *store.Snapshot
	ch   chan store.ConnDiff
}

func (f *fakeSource) Current() *store.Snapshot {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.snap
}

func (f *fakeSource) Subscribe() (<-chan store.ConnDiff, func()) { return f.ch, func() {} }

func (f *fakeSource) set(s *store.Snapshot) {
	f.mu.Lock()
	old := f.snap
	f.snap = s
	f.mu.Unlock()
	f.ch <- store.DiffConnections(old, s)
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

func (f *fakeSink) find(id, status string) *cdr.Update {
	f.mu.Lock()
	defer f.mu.Unlock()
	for i := range f.upds {
		if f.upds[i].ID == id && f.upds[i].Status == status {
			u := f.upds[i]
			return &u
		}
	}
	return nil
}

type fakeFin struct {
	mu          sync.Mutex
	failed      map[string]string
	refunded    map[string]bool
	partsFailed map[string][]int
}

func newFin() *fakeFin {
	return &fakeFin{failed: map[string]string{}, refunded: map[string]bool{}, partsFailed: map[string][]int{}}
}

func (f *fakeFin) MessageFailed(_ context.Context, job *pipeline.DispatchJob, code string, refunded bool) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.failed[job.ID] = code
	f.refunded[job.ID] = refunded
	return nil
}

func (f *fakeFin) PartsFailed(_ context.Context, job *pipeline.DispatchJob, parts []int, _ string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.partsFailed[job.ID] = parts
	return nil
}

func (f *fakeFin) failure(id string) (string, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	c, ok := f.failed[id]
	return c, ok
}

// --- environment -------------------------------------------------------------

type env struct {
	t      *testing.T
	rdb    *redis.Client
	src    *fakeSource
	sink   *fakeSink
	fin    *fakeFin
	biller *billing.Biller
	m      *Manager
	route  string
	tag    string
	client string
	cancel context.CancelFunc
	done   chan struct{}
}

func conn(id string, s *fakeSMSC, mode string) *store.Connection {
	return &store.Connection{ID: id, Name: "conn-" + id[:6], Host: s.host, Port: s.port, SystemID: "sys", Password: "pw",
		BindType: "TRX", Sessions: 2, MaxTPS: 500, WindowSize: 10, EnquireLinkInterval: 30 * time.Second,
		ReconnectMin: 100 * time.Millisecond, ReconnectMax: 200 * time.Millisecond, SubmitTimeout: 2 * time.Second,
		RequestDLR: true, MultipartMode: mode, Enabled: true,
		Rates: nil}
}

func snapshot(route string, conns []*store.Connection, prios []int) *store.Snapshot {
	d := store.Data{Routes: []*store.Route{{ID: route, Name: "r", Enabled: true}}}
	for i, c := range conns {
		cc := *c
		d.Connections = append(d.Connections, &cc)
		d.RouteConnections = append(d.RouteConnections, &store.RouteConnection{RouteID: route, ConnectionID: c.ID, Priority: prios[i], Weight: 1, Enabled: true})
		d.Rates = append(d.Rates, &store.Rate{ConnectionID: c.ID, Prefix: "", CostMicros: 10 * int64(i+1)})
	}
	return store.NewSnapshot(d)
}

func newEnv(t *testing.T, snap *store.Snapshot, route string, claimIdle time.Duration) *env {
	t.Helper()
	e := &env{t: t, rdb: testRedis(t), src: &fakeSource{snap: snap, ch: make(chan store.ConnDiff, 1)}, sink: &fakeSink{}, fin: newFin(),
		route: route, tag: uuid.NewString(), client: uuid.NewString()}
	dirty := "test:dispatch:dirty:" + e.tag
	e.biller = billing.New(e.rdb, nil, billing.Options{DirtyKey: dirty})
	ctx := context.Background()
	e.rdb.HSet(ctx, billing.BalanceKey(e.tag, e.client), "bal", 10_000, "limit", 0)
	e.rdb.HSet(ctx, billing.BalanceKey(e.tag, e.tag), "bal", 10_000, "limit", 0)
	e.m = New(e.src, e.rdb, e.biller, nil, e.sink, e.fin, Options{InstanceID: "test-" + e.tag[:8], ClaimIdle: claimIdle,
		Block: 100 * time.Millisecond, MaxQueueAge: 5 * time.Second, ScanInterval: -1, WorkersPerRoute: 4, Logger: quiet})
	rctx, cancel := context.WithCancel(context.Background())
	e.cancel, e.done = cancel, make(chan struct{})
	go func() { e.m.Run(rctx); close(e.done) }()
	t.Cleanup(func() {
		e.cancel()
		<-e.done
		e.rdb.Del(context.Background(), billing.BalanceKey(e.tag, e.client), billing.BalanceKey(e.tag, e.tag), dirty,
			pipeline.DispatchStream(route))
	})
	return e
}

func (e *env) waitBound(ids ...string) {
	e.t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		ok := true
		for _, id := range ids {
			u := e.m.conn(id)
			if u == nil || len(u.clients) == 0 {
				ok = false
				continue
			}
			for _, c := range u.clients { // every session, not just one
				if !c.State().Status.Bound() {
					ok = false
				}
			}
		}
		if ok {
			return
		}
		if time.Now().After(deadline) {
			e.t.Fatalf("connections not bound: %v", e.m.Status())
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// enqueue debits and queues a message like the pipeline does.
func (e *env) enqueue(dest, text string, parts int) *pipeline.DispatchJob {
	e.t.Helper()
	ctx := context.Background()
	enc := coding.Detect(text).String()
	job := &pipeline.DispatchJob{ID: pipeline.NewMessageID(), CreatedMS: time.Now().UnixMilli(), OrgID: e.client, RouteID: e.route,
		Channel: "HTTP", Source: "ACME", SourceTON: 5, Dest: dest, Text: text, Encoding: enc, Parts: parts, Tag: e.tag,
		Legs: []pipeline.Leg{{OrgID: e.client, Amount: 100 * int64(parts)}, {OrgID: e.tag, Amount: 50 * int64(parts)}}, ClientRate: 100, ResellerRate: 50}
	if _, err := e.biller.Debit(ctx, job.ID, []billing.Leg{{OrgID: e.client, Tag: e.tag, Amount: job.Legs[0].Amount}, {OrgID: e.tag, Tag: e.tag, Amount: job.Legs[1].Amount}}); err != nil {
		e.t.Fatal(err)
	}
	e.rdb.HSet(ctx, pipeline.MsgKey(job.ID), pipeline.FParts, parts, pipeline.FDelivered, 0, pipeline.FFailed, 0)
	e.t.Cleanup(func() { e.rdb.Del(context.Background(), pipeline.MsgKey(job.ID), billing.TxnKey(e.tag, job.ID)) })
	payload, _ := pipeline.EncodeJob(job)
	if err := e.rdb.XAdd(ctx, &redis.XAddArgs{Stream: pipeline.DispatchStream(e.route), Values: []any{pipeline.JobField, payload}}).Err(); err != nil {
		e.t.Fatal(err)
	}
	return job
}

func (e *env) bal(org string) int64 {
	v, _ := e.rdb.HGet(context.Background(), billing.BalanceKey(e.tag, org), "bal").Int64()
	return v
}

func waitUntil(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out: %s", what)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// --- tests -------------------------------------------------------------------

func TestSubmitMultipartUDHAndDLRMap(t *testing.T) {
	a := newSMSC(t, nil)
	route, ca := uuid.NewString(), uuid.NewString()
	e := newEnv(t, snapshot(route, []*store.Connection{conn(ca, a, ModeUDH)}, []int{1}), route, time.Minute)
	e.waitBound(ca)
	text := strings.Repeat("x", 200)
	job := e.enqueue("447700900001", text, 2)
	var u *cdr.Update
	waitUntil(t, "submitted", func() bool { u = e.sink.find(job.ID, cdr.StatusSubmitted); return u != nil })
	if u.ConnectionID != ca || len(u.SMSCMsgIDs) != 2 || u.SubmittedAt == nil || u.RouteCostMicros == nil || *u.RouteCostMicros != 20 {
		t.Fatalf("update %+v", u)
	}
	m := a.get("447700900001")
	if m == nil || m.Text != text || m.Parts != 2 || m.Multipart != server.MultipartUDH8 || m.RegisteredDelivery != 1 || m.DestTON != 1 || m.SourceTON != 5 {
		t.Fatalf("smsc got %+v", m)
	}
	ctx := context.Background()
	for i, id := range u.SMSCMsgIDs {
		v, err := e.rdb.Get(ctx, pipeline.DLRMapKey(ca, pdu.NormalizeMessageID(id))).Result()
		if err != nil || v != pipeline.DLRMapValue(job.ID, i, job.CreatedMS) {
			t.Fatalf("dlrmap %d: %q %v", i, v, err)
		}
		e.rdb.Del(ctx, pipeline.DLRMapKey(ca, pdu.NormalizeMessageID(id)))
	}
	h, _ := e.rdb.HGetAll(ctx, pipeline.MsgKey(job.ID)).Result()
	if h[pipeline.FPDUs] != "2" || h[pipeline.FConnection] != ca || h[pipeline.FSubmittedMS] == "" {
		t.Fatalf("msg state %v", h)
	}
	waitUntil(t, "acked", func() bool { return e.rdb.XLen(ctx, pipeline.DispatchStream(route)).Val() == 0 })
	if e.bal(e.client) != 10_000-200 {
		t.Fatalf("charged %d", 10_000-e.bal(e.client))
	}
}

func TestPartialMultipartFailureRefundsRejectedParts(t *testing.T) {
	// The fake SMSC answers the completing (last) part with the handler status.
	a := newSMSC(t, rejectSuffix("9999"))
	route, ca := uuid.NewString(), uuid.NewString()
	e := newEnv(t, snapshot(route, []*store.Connection{conn(ca, a, ModeSAR)}, []int{1}), route, time.Minute)
	e.waitBound(ca)
	job := e.enqueue("447700909999", strings.Repeat("y", 200), 2)
	var u *cdr.Update
	waitUntil(t, "submitted", func() bool { u = e.sink.find(job.ID, cdr.StatusSubmitted); return u != nil })
	if len(u.SMSCMsgIDs) != 1 || u.ClientCostMicros == nil || *u.ClientCostMicros != 100 || *u.ResellerCostMicros != 50 {
		t.Fatalf("update %+v", u)
	}
	e.fin.mu.Lock()
	parts := e.fin.partsFailed[job.ID]
	e.fin.mu.Unlock()
	if len(parts) != 1 || parts[0] != 1 {
		t.Fatalf("parts failed %v", parts)
	}
	if e.bal(e.client) != 10_000-100 || e.bal(e.tag) != 10_000-50 {
		t.Fatalf("balances %d %d", e.bal(e.client), e.bal(e.tag))
	}
	for _, id := range u.SMSCMsgIDs {
		e.rdb.Del(context.Background(), pipeline.DLRMapKey(ca, pdu.NormalizeMessageID(id)))
	}
}

func TestFailoverAndAllFailedRefund(t *testing.T) {
	a := newSMSC(t, rejectSuffix("1111"))
	b := newSMSC(t, rejectSuffix("11111"))
	route, ca, cb := uuid.NewString(), uuid.NewString(), uuid.NewString()
	e := newEnv(t, snapshot(route, []*store.Connection{conn(ca, a, ModeUDH), conn(cb, b, ModeUDH)}, []int{1, 2}), route, time.Minute)
	e.waitBound(ca, cb)

	// Rejected by A only → delivered via B.
	j1 := e.enqueue("447700901111", "hello", 1)
	var u *cdr.Update
	waitUntil(t, "failover submit", func() bool { u = e.sink.find(j1.ID, cdr.StatusSubmitted); return u != nil })
	if u.ConnectionID != cb || a.count("447700901111") != 1 || b.count("447700901111") != 1 || *u.RouteCostMicros != 20 {
		t.Fatalf("update %+v a=%d b=%d", u, a.count("447700901111"), b.count("447700901111"))
	}
	for _, id := range u.SMSCMsgIDs {
		e.rdb.Del(context.Background(), pipeline.DLRMapKey(cb, pdu.NormalizeMessageID(id)))
	}
	// Rejected by both → FAILED + full refund.
	before, beforeRes := e.bal(e.client), e.bal(e.tag)
	j2 := e.enqueue("447700011111", "hello", 1)
	waitUntil(t, "failure", func() bool { _, ok := e.fin.failure(j2.ID); return ok })
	code, _ := e.fin.failure(j2.ID)
	if code != "ESME_RSUBMITFAIL" || !e.fin.refunded[j2.ID] {
		t.Fatalf("code %s refunded %v", code, e.fin.refunded[j2.ID])
	}
	if e.bal(e.client) != before || e.bal(e.tag) != beforeRes {
		t.Fatalf("not refunded: %d (before %d), reseller %d", e.bal(e.client), before, e.bal(e.tag))
	}
	if a.count("447700011111") != 1 || b.count("447700011111") != 1 {
		t.Fatal("expected one attempt per connection")
	}
}

func TestReclaimStuckEntryAndSkipAlreadySubmitted(t *testing.T) {
	a := newSMSC(t, nil)
	route, ca := uuid.NewString(), uuid.NewString()
	snap := snapshot(route, []*store.Connection{conn(ca, a, ModeUDH)}, []int{1})
	ctx := context.Background()
	stream := pipeline.DispatchStream(route)
	if err := testRedis(t).XGroupCreateMkStream(ctx, stream, pipeline.DispatchGroup, "0").Err(); err != nil {
		t.Fatal(err)
	}
	e := newEnv(t, snap, route, 300*time.Millisecond)
	// Stop consuming so a "dead" consumer can grab the entry first.
	e.cancel()
	<-e.done
	job := e.enqueue("447700902222", "stuck", 1)
	if _, err := e.rdb.XReadGroup(ctx, &redis.XReadGroupArgs{Group: pipeline.DispatchGroup, Consumer: "dead", Streams: []string{stream, ">"}, Count: 10}).Result(); err != nil {
		t.Fatal(err)
	}
	// An already-submitted message re-delivered must not be sent again.
	dup := e.enqueue("447700903333", "dup", 1)
	e.rdb.HSet(ctx, pipeline.MsgKey(dup.ID), pipeline.FSubmittedMS, time.Now().UnixMilli())

	e2 := newEnv(t, snap, route, 300*time.Millisecond)
	e2.sink, e2.m.sink = e.sink, e.sink
	e2.waitBound(ca)
	waitUntil(t, "reclaimed and submitted", func() bool { return e.sink.find(job.ID, cdr.StatusSubmitted) != nil })
	waitUntil(t, "stream drained", func() bool { return e.rdb.XLen(ctx, stream).Val() == 0 })
	if a.count("447700903333") != 0 {
		t.Fatal("already-submitted message sent twice")
	}
	if u := e.sink.find(job.ID, cdr.StatusSubmitted); u != nil {
		for _, id := range u.SMSCMsgIDs {
			e.rdb.Del(ctx, pipeline.DLRMapKey(ca, pdu.NormalizeMessageID(id)))
		}
	}
}

func TestRebindOnConfigChangeAndStatus(t *testing.T) {
	a := newSMSC(t, nil)
	b := newSMSC(t, nil)
	route, ca, cd := uuid.NewString(), uuid.NewString(), uuid.NewString()
	disabled := conn(cd, a, ModeUDH)
	disabled.Enabled = false
	snap := snapshot(route, []*store.Connection{conn(ca, a, ModeUDH), disabled}, []int{1, 2})
	e := newEnv(t, snap, route, time.Minute)
	e.waitBound(ca)

	st := map[string]ConnStatus{}
	for _, s := range e.m.Status() {
		st[s.ConnectionID] = s
	}
	if st[ca].State != "BOUND" || len(st[ca].Sessions) != 2 || st[ca].Sessions[0].State != "BOUND_TRX" || st[ca].TPSLimit != 500 {
		t.Fatalf("status %+v", st[ca])
	}
	if st[cd].State != "DISABLED" || len(st[cd].Sessions) != 0 {
		t.Fatalf("disabled status %+v", st[cd])
	}

	// Point the connection at SMSC B: the manager rebinds.
	moved := conn(ca, b, ModeUDH)
	e.src.set(snapshot(route, []*store.Connection{moved, disabled}, []int{1, 2}))
	waitUntil(t, "rebound to B", func() bool {
		u := e.m.conn(ca)
		return u != nil && u.cfg.Port == b.port && u.canTransmit()
	})
	job := e.enqueue("447700904444", "after rebind", 1)
	var u *cdr.Update
	waitUntil(t, "submitted via B", func() bool { u = e.sink.find(job.ID, cdr.StatusSubmitted); return u != nil })
	if b.count("447700904444") != 1 || a.count("447700904444") != 0 {
		t.Fatal("message did not go to the rebound SMSC")
	}
	for _, id := range u.SMSCMsgIDs {
		e.rdb.Del(context.Background(), pipeline.DLRMapKey(ca, pdu.NormalizeMessageID(id)))
	}
	waitUntil(t, "old sessions unbound from A", func() bool { return len(a.srv.Sessions()) == 0 })
}

func TestRouteUnavailableFailsAndRefunds(t *testing.T) {
	a := newSMSC(t, nil)
	route, ca := uuid.NewString(), uuid.NewString()
	c := conn(ca, a, ModeUDH)
	snap := snapshot(route, []*store.Connection{c}, []int{1})
	e := newEnv(t, snap, route, time.Minute)
	e.waitBound(ca)
	// Route removed from config while messages are queued.
	e.src.set(store.NewSnapshot(store.Data{Connections: []*store.Connection{c}}))
	job := e.enqueue("447700905555", "orphan", 1)
	// The stream is still consumed (queue registered); the message fails.
	waitUntil(t, "failed", func() bool { _, ok := e.fin.failure(job.ID); return ok })
	if code, _ := e.fin.failure(job.ID); code != "ROUTE_UNAVAILABLE" || e.bal(e.client) != 10_000 {
		t.Fatalf("code %s bal %d", code, e.bal(e.client))
	}
}

func TestBuildPDUs(t *testing.T) {
	job := &pipeline.DispatchJob{Source: "ACME", SourceTON: 5, Dest: "4477", Text: strings.Repeat("é", 100), Encoding: "UCS2"}
	c := &store.Connection{MultipartMode: ModePayload, RequestDLR: false}
	pdus, err := buildPDUs(job, c)
	if err != nil || len(pdus) != 1 || len(pdus[0].ShortMessage) != 0 || pdus[0].RegisteredDelivery != 0 || pdus[0].DataCoding != 8 {
		t.Fatalf("payload: %v %+v", err, pdus)
	}
	if p, ok := pdus[0].TLVs.MessagePayload(); !ok || len(p) != 200 {
		t.Fatalf("payload len %d", len(p))
	}
	c.MultipartMode, c.RequestDLR = ModeSAR, true
	pdus, _ = buildPDUs(job, c)
	if len(pdus) != 2 || pdus[0].ESMClass&pdu.ESMClassUDHI != 0 || pdus[1].RegisteredDelivery != 1 {
		t.Fatalf("sar %+v", pdus)
	}
	ref, total, seq, ok := pdus[1].TLVs.SAR()
	if r0, _, _, _ := pdus[0].TLVs.SAR(); !ok || total != 2 || seq != 2 || ref != r0 {
		t.Fatal("sar tlvs")
	}
	c.MultipartMode = ModeUDH
	pdus, _ = buildPDUs(job, c)
	if len(pdus) != 2 || pdus[0].ESMClass&pdu.ESMClassUDHI == 0 || pdus[0].ShortMessage[0] != 5 || pdus[1].ShortMessage[5] != 2 {
		t.Fatalf("udh %+v", pdus[0])
	}
	// IA5 default data coding for plain ASCII; GSM 03.38 otherwise.
	c.DefaultDataCoding = 1
	pdus, _ = buildPDUs(&pipeline.DispatchJob{Text: "Hello @ you", Encoding: "GSM7"}, c)
	if pdus[0].DataCoding != 1 || string(pdus[0].ShortMessage) != "Hello @ you" {
		t.Fatalf("ia5 %+v", pdus[0])
	}
	pdus, _ = buildPDUs(&pipeline.DispatchJob{Text: "Hällo", Encoding: "GSM7"}, c)
	if pdus[0].DataCoding != 0 || pdus[0].ShortMessage[1] != 0x7B {
		t.Fatalf("gsm %+v", pdus[0])
	}
	if b := bucketBurst(5); b != 1 {
		t.Fatal(b)
	}
	_ = fmt.Sprint()
}
