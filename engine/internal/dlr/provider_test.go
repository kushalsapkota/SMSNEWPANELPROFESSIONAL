package dlr

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/google/uuid"

	"smsgw/engine/internal/cdr"
	"smsgw/engine/internal/pipeline"
)

// HTTP provider receipts (poll / callback) go through the same aggregation
// and client event path as SMPP receipts, matched by the exact provider id.
func TestHandleProviderReceipt(t *testing.T) {
	rdb := testRedis(t)
	ctx := context.Background()
	stream := "test:dlr-out:" + uuid.NewString()
	t.Cleanup(func() { rdb.Del(context.Background(), stream) })
	sink := &fakeSink{}
	p := NewProcessor(rdb, sink, nil, Options{Stream: stream, LookupWait: 100 * time.Millisecond})
	conn := uuid.NewString()

	id := newMsg(t, rdb, 2, 1) // 2 billed parts, one provider request
	created := time.Now().UnixMilli()
	key := pipeline.DLRMapKey(conn, "msg_abc")
	rdb.Set(ctx, key, pipeline.DLRMapValue(id, 0, created), time.Minute)
	t.Cleanup(func() { rdb.Del(context.Background(), key) })

	if ok, err := p.HandleProviderReceipt(ctx, conn, "msg_abc", "", ""); ok || err != nil {
		t.Fatalf("intermediate: %v %v", ok, err)
	}
	ok, err := p.HandleProviderReceipt(ctx, conn, "msg_abc", "DELIVRD", "")
	if !ok || err != nil {
		t.Fatalf("delivered: %v %v", ok, err)
	}
	u := sink.last()
	if u.ID != id || u.Status != cdr.StatusDelivered || u.DLRStat == nil || *u.DLRStat != "DELIVRD" || u.DLRReceivedAt == nil {
		t.Fatalf("cdr %+v", u)
	}
	msgs, _ := rdb.XRange(ctx, stream, "-", "+").Result()
	if len(msgs) != 1 {
		t.Fatalf("events %d", len(msgs))
	}
	var ev Event
	_ = json.Unmarshal([]byte(msgs[0].Values[EventField].(string)), &ev)
	if ev.MessageID != id || ev.Status != cdr.StatusDelivered || ev.DLRStat != "DELIVRD" || ev.Parts != 2 {
		t.Fatalf("event %+v", ev)
	}
	// A replay is recorded once.
	if ok, err := p.HandleProviderReceipt(ctx, conn, "msg_abc", "DELIVRD", ""); !ok || err != nil {
		t.Fatalf("replay %v %v", ok, err)
	}
	if n, _ := rdb.XLen(ctx, stream).Result(); n != 1 {
		t.Fatalf("replay emitted again: %d", n)
	}
	// Unknown id; and no hex/decimal variant matching for provider ids.
	if ok, err := p.HandleProviderReceipt(ctx, conn, "msg_zzz", "UNDELIV", ""); ok || err != nil {
		t.Fatalf("unmatched: %v %v", ok, err)
	}
	id2 := newMsg(t, rdb, 1, 1)
	key2 := pipeline.DLRMapKey(conn, "255") // decimal 255 = hex ff
	rdb.Set(ctx, key2, pipeline.DLRMapValue(id2, 0, created), time.Minute)
	t.Cleanup(func() { rdb.Del(context.Background(), key2) })
	if ok, _ := p.HandleProviderReceipt(ctx, conn, "ff", "UNDELIV", ""); ok {
		t.Fatal("provider id matched through a hex variant")
	}
	if ok, _ := p.HandleProviderReceipt(ctx, conn, "255", "UNDELIV", "021"); !ok {
		t.Fatal("exact id not matched")
	}
	if u := sink.last(); u.ID != id2 || u.Status != cdr.StatusUndelivered || *u.DLRErr != "021" {
		t.Fatalf("cdr %+v", u)
	}
}
