package app

import (
	"context"
	"log/slog"
	"net"
	"net/netip"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"smsgw/engine/internal/crypto"
	"smsgw/engine/internal/pipeline"
	"smsgw/engine/internal/policy"
	"smsgw/engine/internal/smpp/pdu"
	"smsgw/engine/internal/smpp/server"
	"smsgw/engine/internal/store"
)

// authenticator verifies client SMPP binds (CONTRACTS §4 / §9):
// unknown system_id → ESME_RINVSYSID; bad password → ESME_RINVPASWD
// (argon2id, successful verifications cached 10 min); org suspended /
// sending stopped / SMPP disabled / account disabled → ESME_RINVSYSID;
// bind type not allowed → ESME_RBINDFAIL; IP not whitelisted (scope SMPP)
// → ESME_RBINDFAIL. max_binds is enforced by the server via Identity.
//
// Brute-force protection: the IP whitelist is checked BEFORE the password
// (callers outside it learn nothing about the password and cost no
// argon2), and a remote IP or system_id with too many recent failures is
// refused (ESME_RBINDFAIL) without running argon2, unless the exact
// credentials verified recently. The server also closes a connection after
// a few failed binds.
type authenticator struct {
	store       pipeline.Snapshotter
	cache       *crypto.BindCache
	guard       *bindGuard
	db          *pgxpool.Pool
	log         *slog.Logger
	sem         chan struct{} // bounds concurrent argon2 evaluations (~19 MiB each)
	maxSessions int
	sessions    func() int
}

func (a *authenticator) Authenticate(ctx context.Context, req *server.BindRequest) (*server.Identity, pdu.CommandStatus) {
	snap := a.store.Current()
	if snap == nil {
		return nil, pdu.ESME_RSYSERR
	}
	if a.maxSessions > 0 && a.sessions != nil && a.sessions() >= a.maxSessions {
		a.log.Warn("SMPP bind rejected: server session limit reached", "system_id", req.SystemID, "limit", a.maxSessions)
		return nil, pdu.ESME_RBINDFAIL
	}
	ip := remoteIP(req.RemoteAddr)
	ipKey := ip.String()
	acct := snap.SMPPAccount(req.SystemID)
	if acct == nil {
		if a.guard != nil {
			if a.guard.blocked(ipKey, "") {
				return nil, pdu.ESME_RBINDFAIL
			}
			a.guard.fail(ipKey, "")
		}
		return nil, pdu.ESME_RINVSYSID
	}
	if err := policy.CheckIP(snap, acct.OrgID, ip, store.ScopeSMPP); err != nil {
		a.log.Info("SMPP bind rejected", "system_id", req.SystemID, "ip", ipKey, "reason", err.Error())
		if a.guard != nil {
			a.guard.fail(ipKey, "")
		}
		return nil, pdu.CommandStatus(policy.SMPPBindStatus(policy.CodeOf(err)))
	}
	if !a.cache.Cached(req.SystemID, req.Password, acct.PasswordHash) {
		if a.guard != nil && a.guard.blocked(ipKey, req.SystemID) {
			a.log.Warn("SMPP bind refused: too many failed attempts", "system_id", req.SystemID, "ip", ipKey)
			return nil, pdu.ESME_RBINDFAIL
		}
		select {
		case a.sem <- struct{}{}:
		case <-ctx.Done():
			return nil, pdu.ESME_RSYSERR
		}
		ok, err := a.cache.Verify(req.SystemID, req.Password, acct.PasswordHash)
		<-a.sem
		if err != nil {
			a.log.Error("SMPP account has an unusable password hash", "system_id", req.SystemID, "err", err)
			return nil, pdu.ESME_RINVPASWD
		}
		if !ok {
			if a.guard != nil {
				a.guard.fail(ipKey, req.SystemID)
			}
			return nil, pdu.ESME_RINVPASWD
		}
	}
	if err := policy.CheckBind(snap, acct, req.BindType.String(), ip); err != nil {
		a.log.Info("SMPP bind rejected", "system_id", req.SystemID, "ip", ipKey, "reason", err.Error())
		return nil, pdu.CommandStatus(policy.SMPPBindStatus(policy.CodeOf(err)))
	}
	org := snap.Org(acct.OrgID)
	var allowed []pdu.BindType
	for _, s := range acct.AllowedBindTypes {
		if bt, err := pdu.ParseBindType(s); err == nil {
			allowed = append(allowed, bt)
		}
	}
	if len(allowed) == 0 {
		return nil, pdu.ESME_RBINDFAIL
	}
	if a.db != nil {
		go a.recordBind(acct.ID, ip)
	}
	return &server.Identity{
		OrgID:            acct.OrgID,
		SystemID:         acct.SystemID,
		AllowedBindTypes: allowed,
		MaxBinds:         acct.MaxBinds,
		TPS:              policy.EffectiveTPS(org, acct),
		Attributes:       acct.ID,
	}, pdu.ESME_ROK
}

func (a *authenticator) recordBind(acctID string, ip netip.Addr) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var addr any
	if ip.IsValid() {
		addr = ip.String()
	}
	if _, err := a.db.Exec(ctx, `UPDATE smpp_accounts SET last_bind_at = now(), last_bind_ip = $2 WHERE id = $1`, acctID, addr); err != nil {
		a.log.Debug("record SMPP bind failed", "err", err)
	}
}

func remoteIP(a net.Addr) netip.Addr {
	if a == nil {
		return netip.Addr{}
	}
	if t, ok := a.(*net.TCPAddr); ok {
		if ip, ok := netip.AddrFromSlice(t.IP); ok {
			return ip.Unmap()
		}
	}
	if ap, err := netip.ParseAddrPort(a.String()); err == nil {
		return ap.Addr().Unmap()
	}
	return netip.Addr{}
}

// smppHandler feeds complete client messages into the pipeline.
type smppHandler struct {
	p   *pipeline.Pipeline
	log *slog.Logger
}

func (h *smppHandler) NewMessageID() string { return pipeline.NewMessageID() }

func (h *smppHandler) HandleMessage(ctx context.Context, m *server.Message) pdu.CommandStatus {
	_, err := h.p.Submit(ctx, pipeline.Request{
		OrgID:              m.Session.OrgID,
		Channel:            store.ChannelSMPP,
		Source:             m.SourceAddr,
		Destination:        m.DestAddr,
		Text:               m.Text,
		MessageID:          m.ID,
		SMPPSystemID:       m.Session.SystemID,
		RegisteredDelivery: m.RegisteredDelivery,
	})
	if err != nil {
		code := policy.CodeOf(err)
		if code == policy.CodeInternal {
			h.log.Error("SMPP submit failed", "system_id", m.Session.SystemID, "err", err)
		} else {
			h.log.Debug("SMPP submit rejected", "system_id", m.Session.SystemID, "code", code)
		}
		return pdu.CommandStatus(policy.SMPPSubmitStatus(code))
	}
	return pdu.ESME_ROK
}

// sweepSessions unbinds client sessions whose org or account may no longer
// use SMPP (suspension, SMPP disabled, account disabled/deleted) — a safety
// net in addition to the api's explicit kick.
func sweepSessions(snap *store.Snapshot, srv *server.Server, log *slog.Logger) {
	for _, s := range srv.Sessions() {
		acct := snap.SMPPAccount(s.SystemID)
		org := snap.Org(s.OrgID)
		reason := ""
		switch {
		case acct == nil || acct.OrgID != s.OrgID:
			reason = "account removed"
		case !acct.Enabled:
			reason = "account disabled"
		case org == nil:
			reason = "organization removed"
		case policy.CheckOrg(org, store.ChannelSMPP) != nil:
			reason = policy.CheckOrg(org, store.ChannelSMPP).Error()
		}
		if reason != "" {
			n := srv.KickSystemID(s.SystemID)
			log.Info("unbound SMPP client sessions", "system_id", s.SystemID, "org_id", s.OrgID, "sessions", n, "reason", reason)
		}
	}
}
