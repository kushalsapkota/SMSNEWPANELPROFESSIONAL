package policy

import (
	"net/netip"

	"smsgw/engine/internal/store"
)

// CheckOrg applies CONTRACTS §9 step 1 for a submission on channel
// (store.ChannelHTTP / ChannelWeb / ChannelSMPP), in this order:
// unknown org → UNAUTHORIZED; org or its reseller not ACTIVE →
// ACCOUNT_SUSPENDED; sending stopped → SENDING_DISABLED; channel flag off on
// the org or its reseller → CHANNEL_DISABLED.
func CheckOrg(org *store.Org, channel string) error {
	if org == nil {
		return New(CodeUnauthorized, "unknown organization")
	}
	if !org.Effective.IsActive {
		return New(CodeAccountSuspended, "account is suspended")
	}
	if !org.Effective.CanSend {
		return New(CodeSendingDisabled, "sending is disabled for this account")
	}
	if !org.CanUseChannel(channel) {
		return Errorf(CodeChannelDisabled, "%s access is disabled for this account", channelName(channel))
	}
	return nil
}

// CheckSwitches applies the global operator kill switches (service_switches)
// for a submission on channel. The master switch off → SENDING_DISABLED; the
// channel's own switch off → CHANNEL_DISABLED; a bulk/batch submission with
// bulk sending off → SENDING_DISABLED. These are administrator-initiated
// stops, distinct from per-account suspension.
func CheckSwitches(sw store.Switches, channel string, bulk bool) error {
	if !sw.AllEnabled {
		return New(CodeSendingDisabled, "sending is temporarily disabled by the administrator")
	}
	switch channel {
	case store.ChannelHTTP:
		if !sw.HTTPAPIEnabled {
			return New(CodeChannelDisabled, "the HTTP API is temporarily disabled by the administrator")
		}
	case store.ChannelSMPP:
		if !sw.SMPPEnabled {
			return New(CodeChannelDisabled, "SMPP is temporarily disabled by the administrator")
		}
	}
	if bulk && !sw.BulkEnabled {
		return New(CodeSendingDisabled, "bulk sending is temporarily disabled by the administrator")
	}
	return nil
}

// CheckBind is CheckOrg for an SMPP bind, adding the account checks:
// unknown / disabled account → NOT_FOUND / CHANNEL_DISABLED, bind type not
// allowed → FORBIDDEN, IP not whitelisted (scope SMPP) → IP_NOT_ALLOWED.
// Password verification is the caller's (crypto.BindCache).
func CheckBind(snap *store.Snapshot, acct *store.SMPPAccount, bindType string, ip netip.Addr) error {
	if acct == nil {
		return New(CodeNotFound, "unknown system_id")
	}
	if err := CheckSwitches(snap.Switches(), store.ChannelSMPP, false); err != nil {
		return err
	}
	if err := CheckOrg(snap.Org(acct.OrgID), store.ChannelSMPP); err != nil {
		return err
	}
	if !acct.Enabled {
		return New(CodeChannelDisabled, "SMPP account is disabled")
	}
	if !acct.AllowsBind(bindType) {
		return Errorf(CodeForbidden, "bind type %s not allowed", bindType)
	}
	return CheckIP(snap, acct.OrgID, ip, store.ScopeSMPP)
}

func channelName(ch string) string {
	switch ch {
	case store.ChannelHTTP:
		return "API"
	case store.ChannelSMPP:
		return "SMPP"
	case store.ChannelWeb:
		return "web"
	}
	return ch
}

// CheckIP returns IP_NOT_ALLOWED unless ip is allowed for org in scope
// (app.ip_allowed semantics: no rows for scope/ALL = open).
func CheckIP(snap *store.Snapshot, orgID string, ip netip.Addr, scope string) error {
	if snap.IPAllowed(orgID, ip, scope) {
		return nil
	}
	return Errorf(CodeIPNotAllowed, "IP %s is not whitelisted", ip)
}

// CheckDestination applies the blocked-number check (global, reseller and
// org scope; prefix match) to a normalized msisdn → DESTINATION_BLOCKED.
func CheckDestination(snap *store.Snapshot, orgID, msisdn string) error {
	if blocked, _, _ := snap.NumberBlocked(orgID, msisdn); blocked {
		return New(CodeDestinationBlocked, "destination is blocked")
	}
	return nil
}

// CheckContent applies blocked keywords (global, reseller, org;
// case-insensitive RE2) → CONTENT_BLOCKED.
func CheckContent(snap *store.Snapshot, orgID, text string) error {
	if k := snap.ContentBlocked(orgID, text); k != nil {
		return New(CodeContentBlocked, "message content is blocked")
	}
	return nil
}

// CheckApprovedContent enforces per-client content pre-approval: when the org
// has content_approval_required set, text must match an APPROVED
// approved_content entry (normalized), else CONTENT_NOT_APPROVED. Orgs
// without the flag are unaffected.
func CheckApprovedContent(snap *store.Snapshot, org *store.Org, text string) error {
	if org == nil || !org.ContentApprovalRequired {
		return nil
	}
	if !snap.ContentApproved(org.ID, text) {
		return New(CodeContentNotApproved, "message content is not approved for this account")
	}
	return nil
}

// ResolveSender applies CONTRACTS §9 step 5. If the route forces a sender
// it is returned with forced=true. Otherwise source is returned unchanged
// when the org has no sender_ids rows or it matches an APPROVED row for this
// route (or for any route); else SENDER_NOT_ALLOWED. Address format
// validation (TON/NPI) is phone.ClassifySender's job.
func ResolveSender(snap *store.Snapshot, orgID string, route *store.Route, source string) (sender string, forced bool, err error) {
	if route != nil && route.ForceSenderID != "" {
		return route.ForceSenderID, true, nil
	}
	routeID := ""
	if route != nil {
		routeID = route.ID
	}
	if ok, _ := snap.SenderAllowed(orgID, routeID, source); !ok {
		return "", false, Errorf(CodeSenderNotAllowed, "sender %q is not approved", source)
	}
	return source, false, nil
}

// EffectiveTPS returns the per-org TPS limit for a submission (CONTRACTS §9
// step 8): the org's effective_max_tps, lowered to the SMPP account's
// max_tps when that is set and smaller. acct may be nil.
func EffectiveTPS(org *store.Org, acct *store.SMPPAccount) int {
	tps := org.Effective.EffectiveMaxTPS
	if tps <= 0 {
		tps = org.MaxTPS
	}
	if acct != nil && acct.MaxTPS > 0 && acct.MaxTPS < tps {
		tps = acct.MaxTPS
	}
	return tps
}
