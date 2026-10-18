package pipeline

import (
	"context"
	"testing"

	"smsgw/engine/internal/billing"
	"smsgw/engine/internal/policy"
	"smsgw/engine/internal/ratelimit"
	"smsgw/engine/internal/store"
)

// An api-chosen message id (internal submit `message_id`) makes a retried
// submit idempotent: the api resubmits ids whose outcome it never saw
// (timeout / 5xx) and must get the original acceptance back, with nothing
// charged, stored or queued twice.

func TestAPIMessageIDReplaysAcceptedSubmit(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	id := NewMessageID()
	f.keys = append(f.keys, MsgKey(id), billing.TxnKey(f.reseller, id))
	req := Request{OrgID: f.client, Channel: store.ChannelHTTP, Source: "MyBank", Destination: "447700900123", Text: "hello", MessageID: id}

	first, err := f.p.Submit(ctx, req)
	if err != nil {
		t.Fatal(err)
	}
	if first.MessageID != id || first.CostMicros != 100 {
		t.Fatalf("first %+v", first)
	}
	again, err := f.p.Submit(ctx, req)
	if err != nil {
		t.Fatalf("replay: %v", err)
	}
	if again.MessageID != id || again.CostMicros != first.CostMicros || again.Parts != first.Parts || again.RouteID != first.RouteID || again.Status != "ACCEPTED" {
		t.Fatalf("replay %+v vs %+v", again, first)
	}
	if f.bal(t, f.client) != 10_000-100 || f.bal(t, f.reseller) != 10_000-50 {
		t.Fatalf("charged twice: %d %d", f.bal(t, f.client), f.bal(t, f.reseller))
	}
	if len(f.sink.ins) != 1 {
		t.Fatalf("%d CDRs", len(f.sink.ins))
	}
	if n := f.rdb.XLen(ctx, DispatchStream(f.route)).Val(); n != 1 {
		t.Fatalf("%d queue entries", n)
	}
}

func TestAPIMessageIDReplayIsNotStoppedByLimits(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	id := NewMessageID()
	f.keys = append(f.keys, MsgKey(id), billing.TxnKey(f.reseller, id))
	l := ratelimit.New(f.rdb)
	_, d, m := l.Keys(f.limitedOrg, "UTC", f.p.d.Now())
	f.keys = append(f.keys, d, m)
	// limitedOrg has a daily limit of 1: the first submit uses it up.
	req := Request{OrgID: f.limitedOrg, Channel: store.ChannelWeb, Source: "A1", Destination: "447700900123", Text: "x", MessageID: id}
	if _, err := f.p.Submit(ctx, req); err != nil {
		t.Fatal(err)
	}
	res, err := f.p.Submit(ctx, req)
	if err != nil || res.MessageID != id {
		t.Fatalf("replay at the daily limit: %+v %v", res, err)
	}
	other := req
	other.MessageID = NewMessageID()
	if _, err := f.p.Submit(ctx, other); policy.CodeOf(err) != policy.CodeDailyLimit {
		t.Fatalf("a new id is still limited: %v", err)
	}
}

func TestAPIMessageIDDuplicateDebitWithoutQueuedMessage(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	submit := func(state string) error {
		id := NewMessageID()
		txn := billing.TxnKey(f.reseller, id)
		f.keys = append(f.keys, MsgKey(id), txn)
		// An earlier attempt debited this id but never queued it.
		f.rdb.HSet(ctx, txn, "n", 2, "state", state)
		_, err := f.p.Submit(ctx, Request{OrgID: f.client, Channel: store.ChannelHTTP, Source: "MyBank", Destination: "447700900123", Text: "x", MessageID: id})
		return err
	}
	// ...and failed (refunded): the retry fails too, nothing is charged.
	if err := submit("REFUNDED"); policy.CodeOf(err) != policy.CodeInternal {
		t.Fatalf("refunded: %v", err)
	}
	// ...or is still in flight: retry later.
	if err := submit("DEBITED"); policy.CodeOf(err) != policy.CodeConflict {
		t.Fatalf("in flight: %v", err)
	}
	if f.bal(t, f.client) != 10_000 || len(f.sink.ins) != 0 {
		t.Fatalf("balance %d, %d CDRs", f.bal(t, f.client), len(f.sink.ins))
	}
}
