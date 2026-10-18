package ratelimit

import (
	"context"
	"os"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"

	"smsgw/engine/internal/policy"
)

func testRedis(t *testing.T) *redis.Client {
	t.Helper()
	u := os.Getenv("TEST_REDIS_URL")
	if u == "" {
		u = "redis://localhost:6399/1"
	}
	opt, err := redis.ParseURL(u)
	if err != nil {
		t.Fatal(err)
	}
	opt.PoolSize = 64
	rdb := redis.NewClient(opt)
	if err := rdb.Ping(context.Background()).Err(); err != nil {
		t.Fatalf("redis: %v", err)
	}
	t.Cleanup(func() { _ = rdb.Close() })
	return rdb
}

func cleanup(t *testing.T, rdb *redis.Client, org string) {
	t.Cleanup(func() {
		ctx := context.Background()
		for _, pat := range []string{"rl:org:" + org + ":*", "cnt:d:" + org + ":*", "cnt:m:" + org + ":*"} {
			it := rdb.Scan(ctx, 0, pat, 100).Iterator()
			for it.Next(ctx) {
				rdb.Del(ctx, it.Val())
			}
		}
	})
}

func fixed(ts time.Time) func() time.Time { return func() time.Time { return ts } }

func TestTPSWindowConcurrent(t *testing.T) {
	rdb := testRedis(t)
	org := uuid.NewString()
	cleanup(t, rdb, org)
	now := time.Date(2024, 5, 1, 12, 0, 0, 0, time.UTC)
	l := New(rdb).WithClock(fixed(now))
	var ok, limited atomic.Int64
	var wg sync.WaitGroup
	for i := 0; i < 100; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := l.Check(context.Background(), Request{OrgID: org, TPS: 25})
			switch policy.CodeOf(err) {
			case "":
				ok.Add(1)
			case policy.CodeRateLimited:
				limited.Add(1)
			default:
				t.Errorf("unexpected %v", err)
			}
		}()
	}
	wg.Wait()
	if ok.Load() != 25 || limited.Load() != 75 {
		t.Fatalf("ok=%d limited=%d", ok.Load(), limited.Load())
	}
	// Rejections did not count toward the day.
	if d, m, _ := l.Usage(context.Background(), org, ""); d != 25 || m != 25 {
		t.Fatalf("usage %d %d", d, m)
	}
	// Next second is a fresh window.
	l.WithClock(fixed(now.Add(time.Second)))
	if _, err := l.Check(context.Background(), Request{OrgID: org, TPS: 25}); err != nil {
		t.Fatal(err)
	}
	tpsKey, dayKey, monthKey := l.Keys(org, "", now)
	if ttl := rdb.TTL(context.Background(), tpsKey).Val(); ttl <= 0 || ttl > 2*time.Second {
		t.Fatalf("tps ttl %v", ttl)
	}
	if ttl := rdb.TTL(context.Background(), dayKey).Val(); ttl < 12*time.Hour || ttl > 13*time.Hour {
		t.Fatalf("day ttl %v (noon UTC -> ~13h)", ttl)
	}
	if ttl := rdb.TTL(context.Background(), monthKey).Val(); ttl < 30*24*time.Hour || ttl > 32*24*time.Hour {
		t.Fatalf("month ttl %v", ttl)
	}
}

func TestDailyAndMonthlyLimits(t *testing.T) {
	rdb := testRedis(t)
	org := uuid.NewString()
	cleanup(t, rdb, org)
	ctx := context.Background()
	t0 := time.Date(2024, 5, 31, 10, 0, 0, 0, time.UTC)
	l := New(rdb).WithClock(fixed(t0))
	req := Request{OrgID: org, TPS: 1000, DailyLimit: 3, MonthlyLimit: 5}
	for i := 0; i < 3; i++ {
		c, err := l.Check(ctx, req)
		if err != nil || c.Day != int64(i+1) {
			t.Fatalf("check %d: %+v %v", i, c, err)
		}
	}
	if _, err := l.Check(ctx, req); policy.CodeOf(err) != policy.CodeDailyLimit {
		t.Fatalf("want DAILY_LIMIT, got %v", err)
	}
	// Next day: daily resets, monthly continues (2 left).
	l.WithClock(fixed(t0.Add(24 * time.Hour))) // June 1 -> new month too
	if c, err := l.Check(ctx, req); err != nil || c.Day != 1 || c.Month != 1 {
		t.Fatalf("new month: %+v %v", c, err)
	}
	// Same month, different day: reaches the monthly limit.
	l.WithClock(fixed(t0.Add(-24 * time.Hour))) // May 30
	if _, err := l.Check(ctx, req); err != nil {
		t.Fatal(err)
	}
	if _, err := l.Check(ctx, req); err != nil {
		t.Fatal(err)
	}
	if _, err := l.Check(ctx, req); policy.CodeOf(err) != policy.CodeMonthlyLimit {
		t.Fatalf("want MONTHLY_LIMIT, got %v", err)
	}
	// Batch of N that would overflow is rejected whole.
	l.WithClock(fixed(t0.Add(48 * time.Hour)))
	if _, err := l.Check(ctx, Request{OrgID: org, TPS: 1000, DailyLimit: 3, N: 4}); policy.CodeOf(err) != policy.CodeDailyLimit {
		t.Fatalf("batch overflow: %v", err)
	}
	if c, err := l.Check(ctx, Request{OrgID: org, TPS: 1000, DailyLimit: 3, N: 3}); err != nil || c.Day != 3 {
		t.Fatalf("batch fit: %+v %v", c, err)
	}
}

func TestReleaseAndTimezone(t *testing.T) {
	rdb := testRedis(t)
	org := uuid.NewString()
	cleanup(t, rdb, org)
	ctx := context.Background()
	// 20:00 UTC = 01:30 next day in Asia/Kolkata.
	t0 := time.Date(2024, 4, 30, 20, 0, 0, 0, time.UTC)
	l := New(rdb).WithClock(fixed(t0))
	_, dayKey, monthKey := l.Keys(org, "Asia/Kolkata", t0)
	if dayKey != "cnt:d:"+org+":20240501" || monthKey != "cnt:m:"+org+":202405" {
		t.Fatalf("tz keys %s %s", dayKey, monthKey)
	}
	if _, d, _ := l.Keys(org, "Not/AZone", t0); d != "cnt:d:"+org+":20240430" {
		t.Fatalf("bad tz should use UTC: %s", d)
	}
	req := Request{OrgID: org, TPS: 10, DailyLimit: 1, Timezone: "Asia/Kolkata"}
	c, err := l.Check(ctx, req)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := l.Check(ctx, req); policy.CodeOf(err) != policy.CodeDailyLimit {
		t.Fatalf("want DAILY_LIMIT, got %v", err)
	}
	if err := l.Release(ctx, req, c.At); err != nil {
		t.Fatal(err)
	}
	if d, m, _ := l.Usage(ctx, org, "Asia/Kolkata"); d != 0 || m != 0 {
		t.Fatalf("after release %d %d", d, m)
	}
	if _, err := l.Check(ctx, req); err != nil {
		t.Fatalf("after release: %v", err)
	}
	// Release never goes negative and keeps the TTL.
	_ = l.Release(ctx, Request{OrgID: org, Timezone: "Asia/Kolkata", N: 10}, c.At)
	if v, _ := rdb.Get(ctx, dayKey).Int64(); v != 0 {
		t.Fatalf("negative counter %d", v)
	}
	if ttl := rdb.TTL(ctx, dayKey).Val(); ttl <= 0 {
		t.Fatalf("ttl lost: %v", ttl)
	}
	// Unlimited.
	org2 := uuid.NewString()
	cleanup(t, rdb, org2)
	for i := 0; i < 50; i++ {
		if _, err := l.Check(ctx, Request{OrgID: org2}); err != nil {
			t.Fatal(err)
		}
	}
}

func TestDailyLimitConcurrent(t *testing.T) {
	rdb := testRedis(t)
	org := uuid.NewString()
	cleanup(t, rdb, org)
	l := New(rdb)
	var ok atomic.Int64
	var wg sync.WaitGroup
	for i := 0; i < 300; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := l.Check(context.Background(), Request{OrgID: org, TPS: 100000, DailyLimit: 120}); err == nil {
				ok.Add(1)
			} else if c := policy.CodeOf(err); c != policy.CodeDailyLimit {
				t.Errorf("unexpected %v", err)
			}
		}()
	}
	wg.Wait()
	if ok.Load() != 120 {
		t.Fatalf("ok=%d want 120", ok.Load())
	}
}
