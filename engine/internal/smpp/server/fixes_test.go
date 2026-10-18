package server_test

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"smsgw/engine/internal/smpp/client"
	"smsgw/engine/internal/smpp/coding"
	"smsgw/engine/internal/smpp/pdu"
	"smsgw/engine/internal/smpp/server"
)

// Receipts are only delivered to sessions of the message's organization:
// a system_id re-created by another tenant must not receive them.
func TestDeliverToMatchesOrganization(t *testing.T) {
	f := newFixture(t, nil)
	c := f.client("alice", pdu.BindReceiver, nil)
	waitBound(t, c)
	waitFor(t, "receiver", func() bool { return f.srv.HasReceiverFor("org-a", "alice") })
	if f.srv.HasReceiverFor("org-other", "alice") {
		t.Fatal("receiver reported for another organization")
	}
	if _, err := f.srv.DeliverTo(context.Background(), "org-other", "alice", &pdu.DeliverSM{}); !errors.Is(err, server.ErrNoSession) {
		t.Fatalf("delivered across tenants: %v", err)
	}
	if _, err := f.srv.DeliverTo(context.Background(), "org-a", "alice", &pdu.DeliverSM{}); err != nil {
		t.Fatal(err)
	}
	rs := f.srv.Receivers()
	if len(rs) != 1 || rs[0] != (server.ReceiverKey{OrgID: "org-a", SystemID: "alice"}) {
		t.Fatalf("receivers %v", rs)
	}
}

// SMPP v3.3 ESMEs must not get optional parameters in bind_resp.
func TestBindRespTLVOnlyForV34(t *testing.T) {
	f := newFixture(t, nil)
	s := raw(t, f.addr)
	resp, err := s.Request(context.Background(), &pdu.Bind{BindType: pdu.BindTransceiver, SystemID: "alice", Password: "pw", InterfaceVersion: 0x33})
	if err != nil || resp.Hdr().Status != pdu.ESME_ROK {
		t.Fatal(resp, err)
	}
	if len(resp.(*pdu.BindResp).TLVs) != 0 {
		t.Fatalf("v3.3 bind_resp carries TLVs: %v", resp.(*pdu.BindResp).TLVs)
	}
}

// One TCP connection cannot keep guessing passwords.
func TestConnectionClosedAfterRepeatedBindFailures(t *testing.T) {
	f := newFixture(t, nil)
	s := raw(t, f.addr)
	ctx := context.Background()
	for i := 0; i < 3; i++ {
		resp, err := s.Request(ctx, &pdu.Bind{BindType: pdu.BindTransceiver, SystemID: "alice", Password: "nope", InterfaceVersion: 0x34})
		if err != nil || resp.Hdr().Status != pdu.ESME_RINVPASWD {
			t.Fatalf("attempt %d: %v %v", i, resp, err)
		}
		if len(resp.(*pdu.BindResp).TLVs) != 0 {
			t.Fatal("failed bind_resp carries TLVs")
		}
	}
	select {
	case <-s.Done():
	case <-time.After(2 * time.Second):
		t.Fatal("connection not closed after 3 failed binds")
	}
}

func udhParts(t *testing.T, text string, ref uint8) []*pdu.SubmitSM {
	t.Helper()
	p, err := coding.Prepare(text)
	if err != nil {
		t.Fatal(err)
	}
	var out []*pdu.SubmitSM
	for _, m := range p.WithUDH(ref) {
		out = append(out, &pdu.SubmitSM{SourceAddr: "SRC", DestinationAddr: "123", ESMClass: pdu.ESMClassUDHI, ShortMessage: m})
	}
	return out
}

// When the completing part is rejected with a retryable status, the ESME
// resubmits only that part: it must complete the same message.
func TestMultipartRetryOfRejectedCompletingPart(t *testing.T) {
	f := newFixture(t, nil)
	f.h.status = pdu.ESME_RTHROTTLED
	c := f.client("alice", pdu.BindTransceiver, nil)
	waitBound(t, c)
	text := strings.Repeat("Hello world {€} ", 20) // 3 parts
	parts := udhParts(t, text, 7)
	ok := submitParts(t, c, parts, []int{0, 1})
	if _, err := c.Submit(context.Background(), parts[2]); err == nil {
		t.Fatal("expected ESME_RTHROTTLED")
	}
	rejected := <-f.h.got
	f.h.mu.Lock()
	f.h.status = pdu.ESME_ROK
	f.h.mu.Unlock()
	r, err := c.Submit(context.Background(), parts[2]) // the ESME's retry
	if err != nil {
		t.Fatalf("retry: %v", err)
	}
	m := <-f.h.got
	if m.Text != text || m.Parts != 3 {
		t.Fatalf("retry did not complete the message: %q (%d parts)", m.Text, m.Parts)
	}
	if m.ID == rejected.ID || r.MessageID != m.ID || ok[0].MessageID != rejected.ID {
		t.Fatalf("ids: rejected %s retried %s resp %s first %s", rejected.ID, m.ID, r.MessageID, ok[0].MessageID)
	}
	select {
	case inc := <-f.expired:
		t.Fatalf("set expired: %+v", inc)
	case <-time.After(100 * time.Millisecond):
	}
}

// Binary / flash data codings and non-concat UDH elements are refused
// instead of being re-encoded as text.
func TestUnsupportedDataCodingAndUDHRejected(t *testing.T) {
	f := newFixture(t, nil)
	c := f.client("alice", pdu.BindTransceiver, nil)
	waitBound(t, c)
	for _, dc := range []uint8{0x02, 0x04, 0xF0, 0xF5, 0x10, 0x18} {
		_, err := c.Submit(context.Background(), &pdu.SubmitSM{SourceAddr: "S", DestinationAddr: "1", DataCoding: dc, ShortMessage: []byte("x")})
		var se *pdu.StatusError
		if !errors.As(err, &se) || se.Status != pdu.ESME_RINVDCS {
			t.Fatalf("dc 0x%02X: %v", dc, err)
		}
	}
	// Application port addressing IE (WAP push / vCard).
	port := append([]byte{0x06, 0x05, 0x04, 0x0B, 0x84, 0x23, 0xF0}, []byte("data")...)
	_, err := c.Submit(context.Background(), &pdu.SubmitSM{SourceAddr: "S", DestinationAddr: "1", ESMClass: pdu.ESMClassUDHI, DataCoding: 0, ShortMessage: port})
	var se *pdu.StatusError
	if !errors.As(err, &se) || se.Status != pdu.ESME_RINVESMCLASS {
		t.Fatalf("port UDH: %v", err)
	}
	// Plain texts still pass.
	for _, dc := range []uint8{0, 1, 3, 8} {
		sm := gsmSubmit("S", "1", "ok")
		sm.DataCoding = dc
		if dc == 8 {
			sm.ShortMessage = coding.EncodeUCS2("ok")
		}
		if _, err := c.Submit(context.Background(), sm); err != nil {
			t.Fatalf("dc %d: %v", dc, err)
		}
		<-f.h.got
	}
}

// memStore is a ConcatStore shared by two servers (two "instances").
type memStore struct {
	mu   sync.Mutex
	sets map[server.ConcatKey]*memSet
}

type memSet struct {
	id    string
	first time.Time
	meta  []byte
	parts map[int][]byte
	ids   map[int]string
}

func (s *memStore) AddPart(_ context.Context, k server.ConcatKey, p server.ConcatPart) (server.ConcatResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	set := s.sets[k]
	if set == nil {
		set = &memSet{id: p.NewSetID, first: p.Now, parts: map[int][]byte{}, ids: map[int]string{}}
		s.sets[k] = set
	}
	if _, ok := set.ids[p.Seq]; !ok {
		set.ids[p.Seq] = set.id
		if p.NewPartID != "" && len(set.parts) > 0 {
			set.ids[p.Seq] = p.NewPartID
		}
	}
	set.parts[p.Seq] = p.Data
	if p.Seq == 1 || set.meta == nil {
		set.meta = p.Meta
	}
	res := server.ConcatResult{SetID: set.id, PartID: set.ids[p.Seq]}
	if len(set.parts) < int(k.Total) {
		return res, nil
	}
	delete(s.sets, k)
	res.Complete, res.Meta, res.FirstSeen = true, set.meta, set.first
	for i := 1; i <= int(k.Total); i++ {
		res.Parts = append(res.Parts, set.parts[i])
		res.PartIDs = append(res.PartIDs, set.ids[i])
	}
	return res, nil
}

func (s *memStore) Rearm(_ context.Context, k server.ConcatKey, res server.ConcatResult, seq int, newID string, _ time.Duration) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.sets[k] != nil {
		return nil
	}
	set := &memSet{id: newID, first: res.FirstSeen, meta: res.Meta, parts: map[int][]byte{}, ids: map[int]string{}}
	for i := 1; i <= int(k.Total); i++ {
		if i != seq {
			set.parts[i], set.ids[i] = res.Parts[i-1], res.PartIDs[i-1]
		}
	}
	s.sets[k] = set
	return nil
}

// With a shared ConcatStore, parts submitted to two different servers
// (binds landed on different instances) join into one message, and a
// rejected completion can be retried on either.
func TestSharedConcatStoreAcrossServers(t *testing.T) {
	store := &memStore{sets: map[server.ConcatKey]*memSet{}}
	shared := func(c *server.Config) { c.ConcatStore = store }
	f1 := newFixture(t, shared)
	// Same handler on both servers (unique message ids, one result channel).
	f2 := newFixture(t, func(c *server.Config) { c.ConcatStore = store; c.Handler = f1.h })
	c1 := f1.client("alice", pdu.BindTransceiver, nil)
	c2 := (&fixture{t: t, addr: f2.addr}).client("alice", pdu.BindTransceiver, nil)
	waitBound(t, c1)
	waitBound(t, c2)
	text := strings.Repeat("Shared parts {€} ", 20)
	parts := udhParts(t, text, 9)
	if len(parts) < 3 {
		t.Fatal(len(parts))
	}
	r0, err := c1.Submit(context.Background(), parts[0])
	if err != nil {
		t.Fatal(err)
	}
	for i := 1; i < len(parts)-1; i++ {
		if _, err := c2.Submit(context.Background(), parts[i]); err != nil {
			t.Fatal(err)
		}
	}
	f1.h.mu.Lock()
	f1.h.status = pdu.ESME_RTHROTTLED
	f1.h.mu.Unlock()
	last := parts[len(parts)-1]
	if _, err := c1.Submit(context.Background(), last); err == nil {
		t.Fatal("expected throttled")
	}
	<-f1.h.got
	f1.h.mu.Lock()
	f1.h.status = pdu.ESME_ROK
	f1.h.mu.Unlock()
	if _, err := c2.Submit(context.Background(), last); err != nil { // retry lands on the other instance
		t.Fatal(err)
	}
	m := <-f1.h.got
	if m.Text != text || m.Parts != len(parts) || m.Session.SystemID != "alice" || m.Session.OrgID != "org-a" {
		t.Fatalf("got %q parts %d session %+v", m.Text, m.Parts, m.Session)
	}
	if r0.MessageID == "" || m.PartIDs[0] != r0.MessageID {
		t.Fatalf("part ids %v first %s", m.PartIDs, r0.MessageID)
	}
	_ = client.StatusDown
}
