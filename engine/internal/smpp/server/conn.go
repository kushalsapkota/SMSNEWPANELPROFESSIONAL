package server

import (
	"context"
	"net"
	"sync"
	"sync/atomic"
	"time"

	"smsgw/engine/internal/smpp/coding"
	"smsgw/engine/internal/smpp/pdu"
	"smsgw/engine/internal/smpp/session"
)

// conn is the server-side state of one connection.
type conn struct {
	srv    *Server
	id     string
	remote net.Addr
	sess   *session.Session

	bindTimer *time.Timer

	// Written once under srv.mu in reserve; read under srv.mu or after
	// ready/bound is observed.
	ident    *Identity
	bindType pdu.BindType

	mu         sync.Mutex
	binding    bool
	bound      bool
	boundSince time.Time
	limiter    *tokenBucket

	ready     atomic.Bool // bind_resp sent: may receive deliver_sm
	kicked    atomic.Bool
	submitted atomic.Uint64
	meter     rateMeter
}

func (c *conn) isBound() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.bound
}

func (c *conn) boundInfo() (SessionInfo, bool) {
	c.mu.Lock()
	bound, since := c.bound, c.boundSince
	c.mu.Unlock()
	if !bound {
		return SessionInfo{}, false
	}
	return SessionInfo{
		ID:             c.id,
		OrgID:          c.ident.OrgID,
		SystemID:       c.ident.SystemID,
		BindType:       c.bindType,
		RemoteAddr:     c.remote.String(),
		BoundSince:     since,
		TPSCurrent:     c.meter.lastSecond(),
		SubmittedTotal: c.submitted.Load(),
		InFlight:       c.sess.InFlight(),
		Identity:       c.ident,
	}, true
}

func (c *conn) handle(s *session.Session, req pdu.PDU) {
	switch p := req.(type) {
	case *pdu.Bind:
		c.handleBind(p)
	case *pdu.SubmitSM:
		c.handleSubmit(p)
	case *pdu.DataSM:
		c.handleDataSM(p)
	default:
		st := pdu.ESME_RINVCMDID
		if _, ok := req.(*pdu.DeliverSM); ok {
			st = pdu.ESME_RINVBNDSTS
		}
		c.respond(pdu.NewResponse(req, st))
	}
}

func (c *conn) respond(p pdu.PDU) {
	if err := c.sess.Respond(p); err != nil {
		c.srv.log.Warn("smpp server: respond failed", "session", c.id, "cmd", p.CommandID().String(), "err", err)
	}
}

func (c *conn) handleBind(p *pdu.Bind) {
	resp := pdu.NewResponse(p, pdu.ESME_ROK).(*pdu.BindResp)
	resp.SystemID = c.srv.cfg.SystemID
	resp.TLVs.Set(pdu.TagSCInterfaceVersion, []byte{pdu.InterfaceVersion34})
	fail := func(st pdu.CommandStatus) {
		resp.Status = st
		c.respond(resp)
	}

	c.mu.Lock()
	if c.bound || c.binding {
		c.mu.Unlock()
		fail(pdu.ESME_RALYBND)
		return
	}
	c.binding = true
	c.mu.Unlock()
	defer func() {
		c.mu.Lock()
		c.binding = false
		c.mu.Unlock()
	}()

	ctx, cancel := context.WithTimeout(c.srv.ctx, c.srv.cfg.AuthTimeout)
	ident, st := c.srv.cfg.Authenticator.Authenticate(ctx, &BindRequest{
		BindType: p.BindType, SystemID: p.SystemID, Password: p.Password, SystemType: p.SystemType,
		InterfaceVersion: p.InterfaceVersion, AddrTON: p.AddrTON, AddrNPI: p.AddrNPI,
		AddressRange: p.AddressRange, RemoteAddr: c.remote,
	})
	cancel()
	if st == pdu.ESME_ROK && ident == nil {
		st = pdu.ESME_RBINDFAIL
	}
	if st != pdu.ESME_ROK {
		c.srv.log.Info("smpp server: bind rejected", "system_id", p.SystemID, "remote", c.remote.String(), "status", st.String())
		fail(st)
		return
	}
	id := *ident // private copy
	if id.SystemID == "" {
		id.SystemID = p.SystemID
	}
	if !id.allows(p.BindType) {
		fail(pdu.ESME_RBINDFAIL)
		return
	}
	if !c.srv.reserve(c, &id, p.BindType) {
		c.srv.log.Info("smpp server: bind rejected, max_binds reached", "system_id", id.SystemID, "max_binds", id.MaxBinds)
		fail(pdu.ESME_RBINDFAIL)
		return
	}
	c.mu.Lock()
	c.bound = true
	c.boundSince = time.Now()
	if id.TPS > 0 {
		c.limiter = newTokenBucket(id.TPS)
	}
	c.mu.Unlock()
	c.bindTimer.Stop()
	c.respond(resp)
	c.ready.Store(true)
	c.srv.log.Info("smpp server: bound", "session", c.id, "system_id", id.SystemID, "org_id", id.OrgID, "bind", p.BindType.String(), "remote", c.remote.String())
	if c.srv.cfg.OnBind != nil {
		if info, ok := c.boundInfo(); ok {
			c.srv.cfg.OnBind(info)
		}
	}
}

// inbound is the common view of submit_sm and data_sm.
type inbound struct {
	req     pdu.PDU
	sm      pdu.SubmitSM // fields (data_sm mapped onto it)
	payload []byte
}

func (c *conn) handleSubmit(p *pdu.SubmitSM) {
	in := &inbound{req: p, sm: *p}
	if v, ok := p.TLVs.MessagePayload(); ok {
		in.payload = v
	} else {
		in.payload = p.ShortMessage
	}
	c.process(in)
}

func (c *conn) handleDataSM(p *pdu.DataSM) {
	in := &inbound{req: p, sm: pdu.SubmitSM{
		Header: p.Header, ServiceType: p.ServiceType,
		SourceAddrTON: p.SourceAddrTON, SourceAddrNPI: p.SourceAddrNPI, SourceAddr: p.SourceAddr,
		DestAddrTON: p.DestAddrTON, DestAddrNPI: p.DestAddrNPI, DestinationAddr: p.DestinationAddr,
		ESMClass: p.ESMClass, RegisteredDelivery: p.RegisteredDelivery, DataCoding: p.DataCoding, TLVs: p.TLVs,
	}}
	in.payload, _ = p.TLVs.MessagePayload()
	c.process(in)
}

func (c *conn) reply(in *inbound, id string, st pdu.CommandStatus) {
	resp := pdu.NewResponse(in.req, st)
	if st == pdu.ESME_ROK {
		switch r := resp.(type) {
		case *pdu.SubmitSMResp:
			r.MessageID = id
		case *pdu.DataSMResp:
			r.MessageID = id
		}
	}
	c.respond(resp)
}

func (c *conn) process(in *inbound) {
	c.mu.Lock()
	bound, lim := c.bound, c.limiter
	c.mu.Unlock()
	if !bound || !c.bindType.CanTransmit() || c.kicked.Load() {
		c.reply(in, "", pdu.ESME_RINVBNDSTS)
		return
	}
	if lim != nil && !lim.allow() {
		c.reply(in, "", pdu.ESME_RTHROTTLED)
		return
	}
	c.submitted.Add(1)
	c.meter.add()

	info, _ := c.boundInfo()
	now := time.Now()
	m := &Message{
		Session:              info,
		ServiceType:          in.sm.ServiceType,
		SourceAddr:           in.sm.SourceAddr,
		SourceTON:            in.sm.SourceAddrTON,
		SourceNPI:            in.sm.SourceAddrNPI,
		DestAddr:             in.sm.DestinationAddr,
		DestTON:              in.sm.DestAddrTON,
		DestNPI:              in.sm.DestAddrNPI,
		ESMClass:             in.sm.ESMClass,
		ProtocolID:           in.sm.ProtocolID,
		PriorityFlag:         in.sm.PriorityFlag,
		RegisteredDelivery:   in.sm.RegisteredDelivery,
		DataCoding:           in.sm.DataCoding,
		ScheduleDeliveryTime: in.sm.ScheduleDeliveryTime,
		ValidityPeriod:       in.sm.ValidityPeriod,
		TLVs:                 in.sm.TLVs,
		Command:              in.req.CommandID(),
		ReceivedAt:           now,
		Parts:                1,
	}

	var part *partInfo
	data := in.payload
	if in.sm.ESMClass&pdu.ESMClassUDHI != 0 {
		cc, rest, ok, err := coding.ParseConcat(data)
		if err != nil {
			c.reply(in, "", pdu.ESME_RINVESMCLASS)
			return
		}
		data = rest
		if ok {
			kind := MultipartUDH8
			if cc.Ref16 {
				kind = MultipartUDH16
			}
			part = &partInfo{kind: kind, ref: cc.Ref, total: cc.Total, seq: cc.Seq}
		}
	}
	if part == nil {
		if ref, total, seq, ok := in.sm.TLVs.SAR(); ok {
			part = &partInfo{kind: MultipartSAR, ref: ref, total: total, seq: seq}
		}
	}
	if part != nil && part.total > 1 {
		if part.seq < 1 || part.seq > part.total {
			st := pdu.ESME_RINVESMCLASS
			if part.kind == MultipartSAR {
				st = pdu.ESME_RINVOPTPARAMVAL
			}
			c.reply(in, "", st)
			return
		}
		part.data = data
		c.srv.concat.add(c, in, m, part)
		return
	}

	// single message
	if _, ok := in.sm.TLVs.MessagePayload(); ok {
		m.Multipart = MultipartPayload
	}
	m.Payload = data
	m.Text = coding.Decode(m.DataCoding, data)
	m.ID = c.srv.cfg.Handler.NewMessageID()
	m.PartIDs = []string{m.ID}
	st := c.srv.handleMessage(m)
	c.reply(in, m.ID, st)
}

func (s *Server) handleMessage(m *Message) (st pdu.CommandStatus) {
	defer func() {
		if r := recover(); r != nil {
			s.log.Error("smpp server: Handler panicked", "panic", r, "message_id", m.ID)
			st = pdu.ESME_RSYSERR
		}
	}()
	return s.cfg.Handler.HandleMessage(s.ctx, m)
}

// tokenBucket is a simple TPS limiter with burst == rate.
type tokenBucket struct {
	mu     sync.Mutex
	rate   float64
	tokens float64
	last   time.Time
}

func newTokenBucket(tps int) *tokenBucket {
	return &tokenBucket{rate: float64(tps), tokens: float64(tps), last: time.Now()}
}

func (b *tokenBucket) allow() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	now := time.Now()
	b.tokens += now.Sub(b.last).Seconds() * b.rate
	if b.tokens > b.rate {
		b.tokens = b.rate
	}
	b.last = now
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

// rateMeter counts events per wall-clock second.
type rateMeter struct {
	mu        sync.Mutex
	sec       int64
	cur, prev uint64
}

func (r *rateMeter) roll(now int64) {
	switch {
	case now == r.sec:
	case now == r.sec+1:
		r.prev, r.cur, r.sec = r.cur, 0, now
	default:
		r.prev, r.cur, r.sec = 0, 0, now
	}
}

func (r *rateMeter) add() {
	r.mu.Lock()
	r.roll(time.Now().Unix())
	r.cur++
	r.mu.Unlock()
}

// lastSecond returns the count of the last complete second.
func (r *rateMeter) lastSecond() float64 {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.roll(time.Now().Unix())
	return float64(r.prev)
}
