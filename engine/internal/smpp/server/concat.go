package server

import (
	"sync"
	"time"

	"smsgw/engine/internal/smpp/coding"
	"smsgw/engine/internal/smpp/pdu"
)

type partInfo struct {
	kind  MultipartKind
	ref   uint16
	total uint8
	seq   uint8
	data  []byte
}

// Sets are keyed per system_id (not per TCP session): ESMEs with several
// binds commonly spread the parts of one message across them.
type concatKey struct {
	systemID string
	src, dst string
	kind     MultipartKind
	ref      uint16
	total    uint8
}

type concatSet struct {
	key       concatKey
	id        string
	partIDs   []string
	parts     [][]byte
	have      []bool
	received  int
	first     *Message // template from the first-arriving part; replaced by part 1
	firstSeen time.Time
	timer     *time.Timer
}

type reassembler struct {
	srv     *Server
	mu      sync.Mutex
	sets    map[concatKey]*concatSet
	perSys  map[string]int
	stopped bool
}

func newReassembler(s *Server) *reassembler {
	return &reassembler{srv: s, sets: map[concatKey]*concatSet{}, perSys: map[string]int{}}
}

func (r *reassembler) add(c *conn, in *inbound, m *Message, p *partInfo) {
	if r.srv.cfg.ConcatStore != nil {
		r.addShared(c, in, m, p)
		return
	}
	key := concatKey{systemID: m.Session.SystemID, src: m.SourceAddr, dst: m.DestAddr, kind: p.kind, ref: p.ref, total: p.total}
	h := r.srv.cfg.Handler
	idx := int(p.seq) - 1

	r.mu.Lock()
	if r.stopped {
		r.mu.Unlock()
		c.reply(in, "", pdu.ESME_RSYSERR)
		return
	}
	set := r.sets[key]
	if set == nil {
		if r.perSys[key.systemID] >= r.srv.cfg.MaxPendingConcat {
			r.mu.Unlock()
			c.reply(in, "", pdu.ESME_RMSGQFUL)
			return
		}
		set = &concatSet{
			key:       key,
			id:        h.NewMessageID(),
			partIDs:   make([]string, p.total),
			parts:     make([][]byte, p.total),
			have:      make([]bool, p.total),
			first:     m,
			firstSeen: m.ReceivedAt,
		}
		r.sets[key] = set
		r.perSys[key.systemID]++
		set.timer = time.AfterFunc(r.srv.cfg.ConcatTimeout, func() { r.expire(set) })
	}
	if set.partIDs[idx] == "" {
		if r.srv.cfg.PerPartMessageIDs && set.received > 0 {
			set.partIDs[idx] = h.NewMessageID()
		} else {
			set.partIDs[idx] = set.id
		}
	}
	partID := set.partIDs[idx]
	if !set.have[idx] {
		set.have[idx] = true
		set.received++
	}
	set.parts[idx] = p.data // a duplicate part overwrites
	if p.seq == 1 {
		set.first = m
	}
	if set.received < int(p.total) {
		r.mu.Unlock()
		c.reply(in, partID, pdu.ESME_ROK)
		return
	}
	// complete
	set.timer.Stop()
	r.removeLocked(set)
	r.mu.Unlock()

	full := set.first
	var n int
	for _, b := range set.parts {
		n += len(b)
	}
	payload := make([]byte, 0, n)
	for _, b := range set.parts {
		payload = append(payload, b...)
	}
	full.ID = set.id
	full.PartIDs = set.partIDs
	full.Payload = payload
	full.Text = coding.Decode(full.DataCoding, payload)
	full.Parts = int(p.total)
	full.Multipart = p.kind
	full.ReceivedAt = set.firstSeen
	st := r.srv.handleMessage(full)
	if st != pdu.ESME_ROK {
		// The earlier parts were already acknowledged with ESME_ROK, so a
		// compliant ESME resubmits only this (completing) part — e.g. after
		// ESME_RTHROTTLED. Keep the other parts so that retry completes the
		// message again instead of starting a new 1-of-N set that expires.
		r.rearm(set, idx)
	}
	c.reply(in, partID, st)
}

// rearm puts a set whose completed message was rejected back into the
// table without its completing part. The retry gets a fresh message id:
// the rejected attempt may have been recorded under the old one.
func (r *reassembler) rearm(set *concatSet, idx int) {
	h := r.srv.cfg.Handler
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.stopped || r.sets[set.key] != nil {
		return // shutting down, or a new set with this key already started
	}
	set.have[idx] = false
	set.parts[idx] = nil
	set.received--
	// The handler has the completed Message; never mutate it again.
	tmpl := *set.first
	set.first = &tmpl
	old := set.id
	set.id = h.NewMessageID()
	for i, id := range set.partIDs {
		if i == idx || id == old && !set.have[i] {
			set.partIDs[i] = ""
		}
	}
	r.sets[set.key] = set
	r.perSys[set.key.systemID]++
	set.timer = time.AfterFunc(r.srv.cfg.ConcatTimeout, func() { r.expire(set) })
}

func (r *reassembler) removeLocked(set *concatSet) {
	if r.sets[set.key] == set {
		delete(r.sets, set.key)
		if r.perSys[set.key.systemID]--; r.perSys[set.key.systemID] <= 0 {
			delete(r.perSys, set.key.systemID)
		}
	}
}

func (r *reassembler) expire(set *concatSet) {
	r.mu.Lock()
	if r.stopped || r.sets[set.key] != set {
		r.mu.Unlock()
		return
	}
	r.removeLocked(set)
	inc := IncompleteMessage{
		ID:         set.id,
		PartIDs:    append([]string(nil), set.partIDs...),
		Session:    set.first.Session,
		SourceAddr: set.key.src,
		DestAddr:   set.key.dst,
		Received:   set.received,
		Total:      int(set.key.total),
		Multipart:  set.key.kind,
		FirstSeen:  set.firstSeen,
	}
	r.mu.Unlock()
	r.srv.log.Warn("smpp server: incomplete multipart message expired", "message_id", inc.ID, "system_id", set.key.systemID, "received", inc.Received, "total", inc.Total)
	if cb := r.srv.cfg.OnIncomplete; cb != nil {
		cb(inc)
	}
}

func (r *reassembler) stop() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.stopped = true
	for _, s := range r.sets {
		s.timer.Stop()
	}
	r.sets = map[concatKey]*concatSet{}
	r.perSys = map[string]int{}
}
