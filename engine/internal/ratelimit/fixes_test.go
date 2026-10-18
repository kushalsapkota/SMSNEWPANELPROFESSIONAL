package ratelimit

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
)

// A replayed check (go-redis retry after a lost reply) with the same token
// must not count the message twice.
func TestCheckWithTokenIsIdempotent(t *testing.T) {
	rdb := testRedis(t)
	org := uuid.NewString()
	cleanup(t, rdb, org)
	tok := uuid.NewString()
	t.Cleanup(func() { rdb.Del(context.Background(), "rl:once:"+tok) })
	l := New(rdb).WithClock(fixed(time.Date(2024, 5, 1, 12, 0, 0, 0, time.UTC)))
	req := Request{OrgID: org, TPS: 10, DailyLimit: 5, Token: tok}
	c1, err := l.Check(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	c2, err := l.Check(context.Background(), req)
	if err != nil || c2.Day != c1.Day || c2.Second != c1.Second || c1.Day != 1 || c1.Replayed || !c2.Replayed {
		t.Fatalf("replay counted again: %+v then %+v (%v)", c1, c2, err)
	}
	req.Token = uuid.NewString()
	t.Cleanup(func() { rdb.Del(context.Background(), "rl:once:"+req.Token) })
	if c3, err := l.Check(context.Background(), req); err != nil || c3.Day != 2 {
		t.Fatalf("new token: %+v %v", c3, err)
	}
}
