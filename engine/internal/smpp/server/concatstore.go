package server

import (
	"context"
	"encoding/json"
	"time"

	"smsgw/engine/internal/smpp/coding"
	"smsgw/engine/internal/smpp/pdu"
)

// ConcatKey identifies one multipart set (per system_id, not per TCP
// session: ESMEs with several binds spread the parts of one message).
type ConcatKey struct {
	SystemID string
	Src, Dst string
	Kind     MultipartKind
	Ref      uint16
	Total    uint8
}

// ConcatPart is one part handed to a ConcatStore.
type ConcatPart struct {
	Seq  int    // 1-based
	Data []byte // user data without UDH
	// Meta is the encoded template message of this part; the store keeps
	// the one of part 1 (or of the first part seen until part 1 arrives).
	Meta []byte
	// NewSetID is the id to use if this part starts the set; NewPartID (""
	// unless Config.PerPartMessageIDs) the id of this part if it is not the
	// first one received.
	NewSetID, NewPartID string
	Now                 time.Time
	TTL                 time.Duration // set lifetime (Config.ConcatTimeout)
}

// ConcatResult is the outcome of ConcatStore.AddPart.
type ConcatResult struct {
	SetID  string // message id of the set
	PartID string // id to return for this part
	// When Complete, the set was removed from the store and these hold it.
	Complete  bool
	Meta      []byte
	FirstSeen time.Time
	Parts     [][]byte // index seq-1
	PartIDs   []string // index seq-1
}

// ConcatStore keeps incomplete multipart sets outside the process, so that
// parts submitted on binds held by different gateway instances join. A
// shared store has no expiry callback: sets that never complete simply
// expire (OnIncomplete is not called) and MaxPendingConcat is not enforced.
type ConcatStore interface {
	AddPart(ctx context.Context, key ConcatKey, p ConcatPart) (ConcatResult, error)
	// Rearm puts a completed set whose message was rejected back without
	// part seq, under a fresh set id, so a retried part completes it again.
	// It does nothing if a set with the same key exists already.
	Rearm(ctx context.Context, key ConcatKey, res ConcatResult, seq int, newSetID string, ttl time.Duration) error
}

// addShared is reassembler.add for a configured ConcatStore.
func (r *reassembler) addShared(c *conn, in *inbound, m *Message, p *partInfo) {
	st := r.srv.cfg.ConcatStore
	h := r.srv.cfg.Handler
	key := ConcatKey{SystemID: m.Session.SystemID, Src: m.SourceAddr, Dst: m.DestAddr, Kind: p.kind, Ref: p.ref, Total: p.total}
	meta, err := json.Marshal(m)
	if err != nil {
		c.reply(in, "", pdu.ESME_RSYSERR)
		return
	}
	part := ConcatPart{Seq: int(p.seq), Data: p.data, Meta: meta, NewSetID: h.NewMessageID(), Now: m.ReceivedAt, TTL: r.srv.cfg.ConcatTimeout}
	if r.srv.cfg.PerPartMessageIDs {
		part.NewPartID = h.NewMessageID()
	}
	ctx, cancel := context.WithTimeout(r.srv.ctx, 5*time.Second)
	defer cancel()
	res, err := st.AddPart(ctx, key, part)
	if err != nil {
		r.srv.log.Error("smpp server: multipart store failed", "system_id", key.SystemID, "err", err)
		c.reply(in, "", pdu.ESME_RSYSERR) // not stored: the ESME retries the part
		return
	}
	if !res.Complete {
		c.reply(in, res.PartID, pdu.ESME_ROK)
		return
	}
	full := &Message{}
	if err := json.Unmarshal(res.Meta, full); err != nil {
		r.srv.log.Error("smpp server: bad multipart template", "system_id", key.SystemID, "err", err)
		c.reply(in, "", pdu.ESME_RSYSERR)
		return
	}
	var n int
	for _, b := range res.Parts {
		n += len(b)
	}
	payload := make([]byte, 0, n)
	for _, b := range res.Parts {
		payload = append(payload, b...)
	}
	full.ID = res.SetID
	full.PartIDs = res.PartIDs
	full.Payload = payload
	full.Text = coding.Decode(full.DataCoding, payload)
	full.Parts = int(p.total)
	full.Multipart = p.kind
	full.ReceivedAt = res.FirstSeen
	status := r.srv.handleMessage(full)
	if status != pdu.ESME_ROK {
		// See rearm: keep the acknowledged parts for the ESME's retry.
		if err := st.Rearm(ctx, key, res, int(p.seq), h.NewMessageID(), r.srv.cfg.ConcatTimeout); err != nil {
			r.srv.log.Warn("smpp server: could not keep multipart set for retry", "system_id", key.SystemID, "err", err)
		}
	}
	c.reply(in, res.PartID, status)
}
