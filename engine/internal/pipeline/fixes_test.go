package pipeline

import (
	"context"
	"errors"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"

	"smsgw/engine/internal/billing"
	"smsgw/engine/internal/cdr"
	"smsgw/engine/internal/policy"
	"smsgw/engine/internal/ratelimit"
	"smsgw/engine/internal/store"
)

// Billing and MaxParts use the number of segments actually sent.
func TestPartsCountMatchesSplit(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	text := strings.Repeat("a", 152) + "€" + strings.Repeat("a", 152) // Analyze says 2, Split makes 3
	res, err := f.p.Submit(ctx, Request{OrgID: f.client, Channel: store.ChannelHTTP, Source: "MyBank", Destination: "447700900123", Text: text})
	if err != nil {
		t.Fatal(err)
	}
	f.keys = append(f.keys, MsgKey(res.MessageID), billing.TxnKey(f.reseller, res.MessageID))
	if res.Parts != 3 || res.CostMicros != 300 || f.sink.ins[0].Parts != 3 {
		t.Fatalf("parts %d cost %d cdr parts %d", res.Parts, res.CostMicros, f.sink.ins[0].Parts)
	}
	ucs := strings.Repeat("ж", 66) + "😀" + strings.Repeat("ж", 66)
	if info, _ := MeasureText(ucs); info.Parts != 3 {
		t.Fatalf("ucs2 parts %d", info.Parts)
	}
	// 1530 septets: 10 by arithmetic, 11 PDUs on the wire -> too long.
	_, err = f.p.Submit(ctx, Request{OrgID: f.client, Channel: store.ChannelHTTP, Source: "MyBank", Destination: "447700900123", Text: strings.Repeat("€", 765)})
	if policy.CodeOf(err) != policy.CodeMessageTooLong {
		t.Fatalf("765 euro signs: %v", err)
	}
	pr, err := f.p.Preview(ctx, PreviewRequest{Text: text, RouteID: f.route})
	if err != nil || pr.Parts != 3 {
		t.Fatalf("preview %+v %v", pr, err)
	}
}

func TestTextWithNULRejected(t *testing.T) {
	f := newFixture(t)
	before := f.bal(t, f.client)
	_, err := f.p.Submit(context.Background(), Request{OrgID: f.client, Channel: store.ChannelHTTP, Source: "MyBank", Destination: "447700900123", Text: "hello\x00nul"})
	if policy.CodeOf(err) != policy.CodeInvalidRequest {
		t.Fatalf("got %v", err)
	}
	if f.bal(t, f.client) != before || len(f.sink.ins) != 0 {
		t.Fatal("charged or recorded")
	}
}

// debitTimeout runs the debit and then reports a transport error, like a
// read timeout after the script executed.
type debitTimeout struct{ Biller }

func (d debitTimeout) Debit(ctx context.Context, txn string, legs []billing.Leg) (billing.DebitResult, error) {
	if _, err := d.Biller.Debit(ctx, txn, legs); err != nil {
		return billing.DebitResult{}, err
	}
	return billing.DebitResult{}, errors.New("billing: script: read tcp: i/o timeout")
}

func TestDebitErrorIsRefunded(t *testing.T) {
	f := newFixture(t)
	d := f.p.d
	d.Biller = debitTimeout{d.Biller}
	d.Refunder = nil
	p := New(d)
	before, beforeRes := f.bal(t, f.client), f.bal(t, f.reseller)
	_, err := p.Submit(context.Background(), Request{OrgID: f.client, Channel: store.ChannelHTTP, Source: "MyBank", Destination: "447700900123", Text: "hi"})
	if policy.CodeOf(err) != policy.CodeInternal {
		t.Fatalf("got %v", err)
	}
	if f.bal(t, f.client) != before || f.bal(t, f.reseller) != beforeRes {
		t.Fatalf("debit not undone: %d/%d (before %d/%d)", f.bal(t, f.client), f.bal(t, f.reseller), before, beforeRes)
	}
}

// failPipeline fails the enqueue transaction (the one with XADD), either
// before sending it or after it executed (lost reply).
type failPipeline struct {
	afterExec atomic.Bool
	on        atomic.Bool
}

func (h *failPipeline) DialHook(next redis.DialHook) redis.DialHook          { return next }
func (h *failPipeline) ProcessHook(next redis.ProcessHook) redis.ProcessHook { return next }
func (h *failPipeline) ProcessPipelineHook(next redis.ProcessPipelineHook) redis.ProcessPipelineHook {
	return func(ctx context.Context, cmds []redis.Cmder) error {
		isEnqueue := false
		for _, c := range cmds {
			if c.Name() == "xadd" {
				isEnqueue = true
			}
		}
		if !isEnqueue || !h.on.Load() {
			return next(ctx, cmds)
		}
		if h.afterExec.Load() {
			_ = next(ctx, cmds)
		}
		return errors.New("read tcp 127.0.0.1:6399: i/o timeout")
	}
}

func hookedPipeline(t *testing.T, f *fixture, hook *failPipeline) *Pipeline {
	t.Helper()
	opt := f.rdb.Options()
	rdb := redis.NewClient(opt)
	rdb.AddHook(hook)
	t.Cleanup(func() { rdb.Close() })
	d := f.p.d
	d.Redis = rdb
	d.Refunder = nil
	d.Limiter = ratelimit.New(rdb)
	return New(d)
}

func TestEnqueueErrorAfterExecKeepsMessage(t *testing.T) {
	f := newFixture(t)
	hook := &failPipeline{}
	hook.on.Store(true)
	hook.afterExec.Store(true)
	p := hookedPipeline(t, f, hook)
	before := f.bal(t, f.client)
	res, err := p.Submit(context.Background(), Request{OrgID: f.client, Channel: store.ChannelHTTP, Source: "MyBank", Destination: "447700900123", Text: "queued anyway"})
	if err != nil {
		t.Fatalf("message was queued but Submit failed: %v", err)
	}
	f.keys = append(f.keys, MsgKey(res.MessageID), billing.TxnKey(f.reseller, res.MessageID))
	if f.bal(t, f.client) != before-100 {
		t.Fatal("queued message was refunded (free SMS)")
	}
	if n := f.rdb.XLen(context.Background(), DispatchStream(f.route)).Val(); n != 1 {
		t.Fatalf("stream %d", n)
	}
}

func TestEnqueueErrorBeforeExecRefundsAndBlocksDispatch(t *testing.T) {
	f := newFixture(t)
	hook := &failPipeline{}
	hook.on.Store(true)
	p := hookedPipeline(t, f, hook)
	before := f.bal(t, f.client)
	req := Request{OrgID: f.client, Channel: store.ChannelHTTP, Source: "MyBank", Destination: "447700900123", Text: "not queued", MessageID: NewMessageID()}
	_, err := p.Submit(context.Background(), req)
	if policy.CodeOf(err) != policy.CodeInternal {
		t.Fatalf("got %v", err)
	}
	if f.bal(t, f.client) != before {
		t.Fatal("not refunded")
	}
	var upd *cdr.Update
	for i := range f.sink.upds {
		if f.sink.upds[i].Status == cdr.StatusFailed {
			upd = &f.sink.upds[i]
		}
	}
	if upd == nil || upd.Refunded == nil || !*upd.Refunded || *upd.ErrorCode != "ENQUEUE_FAILED" {
		t.Fatalf("cdr %+v", upd)
	}
	id := upd.ID
	f.keys = append(f.keys, MsgKey(id), billing.TxnKey(f.reseller, id))
	if v, _ := f.rdb.HGet(context.Background(), MsgKey(id), FDone).Result(); v != "1" {
		t.Fatal("message not marked done: a late stream entry would be dispatched for free")
	}
	// An api retry with the same message_id must not be told "accepted":
	// the message was never queued (and was refunded).
	hook.on.Store(false)
	if res, err := p.Submit(context.Background(), req); err == nil {
		t.Fatalf("retry of a failed enqueue answered as accepted: %+v", res)
	}
	if f.bal(t, f.client) != before {
		t.Fatal("retry charged")
	}
}

// fakeRefundBiller scripts Refund outcomes.
type fakeRefundBiller struct {
	Biller
	results []error
	status  string
	calls   int
}

func (b *fakeRefundBiller) Refund(ctx context.Context, txn string, legs []billing.Leg, amounts []int64) (billing.RefundResult, error) {
	b.calls++
	if len(b.results) > 0 {
		err := b.results[0]
		b.results = b.results[1:]
		if err != nil {
			return billing.RefundResult{}, err
		}
	}
	return billing.RefundResult{Status: b.status}, nil
}

func TestRefunderOutcomes(t *testing.T) {
	rdb := testRedis(t)
	key := "test:refund:" + uuid.NewString()
	t.Cleanup(func() { rdb.Del(context.Background(), key) })
	sink := &fakeSink{}
	legs := []Leg{{OrgID: "o", Amount: 5}}
	ctx := context.Background()

	b := &fakeRefundBiller{status: billing.StatusNoTxn}
	r := NewRefunder(b, rdb, sink, RefunderOptions{Key: key})
	if out := r.Refund(ctx, "m1", "t", legs, nil, "x", nil); out != RefundNothing {
		t.Fatalf("NO_TXN: %v", out)
	}
	b.status = billing.StatusNothingToRefund
	if out := r.Refund(ctx, "m1", "t", legs, nil, "x", nil); out != RefundApplied {
		t.Fatalf("NOTHING_TO_REFUND: %v", out)
	}
	b.status = billing.StatusOK
	b.results = []error{errors.New("timeout"), errors.New("timeout")}
	t1 := true
	if out := r.Refund(ctx, "m2", "t", legs, nil, "x", &cdr.Update{ID: "m2", Refunded: &t1}); out != RefundQueued {
		t.Fatalf("error: %v", out)
	}
	r.RetryPending(ctx) // fails again: stays queued
	if n := rdb.LLen(ctx, key).Val(); n != 1 {
		t.Fatalf("pending %d", n)
	}
	r.RetryPending(ctx)
	if n := rdb.LLen(ctx, key).Val(); n != 0 || len(sink.upds) != 1 || sink.upds[0].ID != "m2" {
		t.Fatalf("pending %d upds %+v", n, sink.upds)
	}
}
