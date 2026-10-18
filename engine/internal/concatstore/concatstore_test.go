package concatstore

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"

	"smsgw/engine/internal/smpp/client"
	"smsgw/engine/internal/smpp/coding"
	"smsgw/engine/internal/smpp/pdu"
	"smsgw/engine/internal/smpp/server"
)

var quiet = slog.New(slog.NewTextHandler(io.Discard, nil))

func testRedis(t *testing.T) *redis.Client {
	t.Helper()
	u := os.Getenv("TEST_REDIS_URL")
	if u == "" {
		u = "redis://localhost:6399/2"
	}
	opt, err := redis.ParseURL(u)
	if err != nil {
		t.Fatal(err)
	}
	rdb := redis.NewClient(opt)
	if err := rdb.Ping(context.Background()).Err(); err != nil {
		t.Fatalf("redis: %v", err)
	}
	t.Cleanup(func() { rdb.Close() })
	return rdb
}

func TestAddPartRearmAndExpiry(t *testing.T) {
	rdb := testRedis(t)
	s := New(rdb, "test:cc:"+uuid.NewString()[:8]+":")
	ctx := context.Background()
	key := server.ConcatKey{SystemID: "sys", Src: "a:b", Dst: "c", Kind: server.MultipartUDH8, Ref: 5, Total: 3}
	t.Cleanup(func() { rdb.Del(context.Background(), s.Key(key)) })
	part := func(seq int, data, setID, partID string) server.ConcatResult {
		t.Helper()
		r, err := s.AddPart(ctx, key, server.ConcatPart{Seq: seq, Data: []byte(data), Meta: []byte(fmt.Sprintf(`{"m":%d}`, seq)),
			NewSetID: setID, NewPartID: partID, TTL: time.Minute, Now: time.UnixMilli(1000)})
		if err != nil {
			t.Fatal(err)
		}
		return r
	}
	r := part(2, "BB", "set-1", "p-a")
	if r.Complete || r.SetID != "set-1" || r.PartID != "set-1" {
		t.Fatalf("first part %+v", r)
	}
	if r := part(1, "AA", "set-x", "p-b"); r.Complete || r.SetID != "set-1" || r.PartID != "p-b" {
		t.Fatalf("second part %+v", r)
	}
	r = part(3, "C\x00\xff", "set-y", "p-c")
	if !r.Complete || r.SetID != "set-1" || string(r.Meta) != `{"m":1}` || r.FirstSeen.UnixMilli() != 1000 {
		t.Fatalf("complete %+v", r)
	}
	if got := string(r.Parts[0]) + string(r.Parts[1]) + string(r.Parts[2]); got != "AABBC\x00\xff" {
		t.Fatalf("payload %q", got)
	}
	if strings.Join(r.PartIDs, ",") != "p-b,set-1,p-c" {
		t.Fatalf("part ids %v", r.PartIDs)
	}
	if n := rdb.Exists(ctx, s.Key(key)).Val(); n != 0 {
		t.Fatal("completed set not removed")
	}
	// Rejected: re-armed without part 3, under a new id; the retry completes it.
	if err := s.Rearm(ctx, key, r, 3, "set-2", time.Minute); err != nil {
		t.Fatal(err)
	}
	r2 := part(3, "CC", "set-z", "")
	if !r2.Complete || r2.SetID != "set-2" || r2.PartID != "set-2" || string(r2.Parts[0]) != "AA" || r2.PartIDs[0] != "p-b" {
		t.Fatalf("retry %+v", r2)
	}
	// TTL is set from the first part.
	part(1, "AA", "set-3", "")
	if ttl := rdb.PTTL(ctx, s.Key(key)).Val(); ttl <= 0 || ttl > time.Minute {
		t.Fatalf("ttl %v", ttl)
	}
}

type handler struct {
	n   atomic.Uint64
	st  atomic.Uint32
	got chan *server.Message
}

func (h *handler) NewMessageID() string { return fmt.Sprintf("id-%d", h.n.Add(1)) }
func (h *handler) HandleMessage(_ context.Context, m *server.Message) pdu.CommandStatus {
	h.got <- m
	return pdu.CommandStatus(h.st.Load())
}

// Two servers (two engine instances) sharing the Redis store: the parts of
// one message submitted on binds held by different instances join.
func TestPartsAcrossInstancesJoin(t *testing.T) {
	rdb := testRedis(t)
	store := New(rdb, "test:cc:"+uuid.NewString()[:8]+":")
	h := &handler{got: make(chan *server.Message, 10)}
	auth := server.AuthenticatorFunc(func(_ context.Context, r *server.BindRequest) (*server.Identity, pdu.CommandStatus) {
		return &server.Identity{OrgID: "org", SystemID: r.SystemID}, pdu.ESME_ROK
	})
	var addrs []string
	for i := 0; i < 2; i++ {
		srv, err := server.New(server.Config{Authenticator: auth, Handler: h, ConcatStore: store, Logger: quiet, EnquireLinkInterval: -1})
		if err != nil {
			t.Fatal(err)
		}
		a, err := srv.Listen("127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { srv.Close() })
		addrs = append(addrs, a.String())
	}
	// Both binds must use the same system_id for the parts to join.
	sys := "esme-" + uuid.NewString()[:6]
	var cs []*client.Client
	for _, a := range addrs {
		c, err := client.New(client.Config{Addr: a, SystemID: sys, Password: "x", Logger: quiet, EnquireLinkInterval: -1})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { c.Close() })
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		if err := c.WaitBound(ctx); err != nil {
			t.Fatal(err)
		}
		cancel()
		cs = append(cs, c)
	}
	text := strings.Repeat("Across instances {€} ", 15)
	p, err := coding.Prepare(text)
	if err != nil {
		t.Fatal(err)
	}
	segs := p.WithUDH(77)
	if len(segs) < 3 {
		t.Fatalf("%d segments", len(segs))
	}
	var firstID string
	for i, sm := range segs {
		r, err := cs[i%2].Submit(context.Background(), &pdu.SubmitSM{SourceAddr: "SRC", DestinationAddr: "4477", ESMClass: pdu.ESMClassUDHI, ShortMessage: sm})
		if err != nil {
			t.Fatalf("part %d: %v", i, err)
		}
		if i == 0 {
			firstID = r.MessageID
		} else if r.MessageID != firstID {
			t.Fatalf("part %d id %s != %s", i, r.MessageID, firstID)
		}
	}
	select {
	case m := <-h.got:
		if m.Text != text || m.Parts != len(segs) || m.ID != firstID || m.Session.SystemID != sys || m.DestAddr != "4477" {
			t.Fatalf("joined message %q parts %d id %s", m.Text, m.Parts, m.ID)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("parts on two instances never joined")
	}
}
