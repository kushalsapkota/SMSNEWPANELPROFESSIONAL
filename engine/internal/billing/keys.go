package billing

import "strings"

// Key builders per CONTRACTS §7. Every key of one tenant tree carries the
// hash tag {t:<reseller_id>} so a client's and its reseller's balance live in
// the same Redis Cluster slot, as debit.lua requires.

// BalanceKey is {t:<tag>}:bal:<org_id>.
func BalanceKey(tag, orgID string) string { return "{t:" + tag + "}:bal:" + orgID }

// TxnKey is {t:<tag>}:txn:<message_id>.
func TxnKey(tag, txnID string) string { return "{t:" + tag + "}:txn:" + txnID }

// CreditKey is {t:<tag>}:credit:<idempotency_key>.
func CreditKey(tag, idemKey string) string { return "{t:" + tag + "}:credit:" + idemKey }

// DefaultDirtyKey is the Redis set of "<tag>|<org_id>" members whose loaded
// balance changed since the last sync (engine-owned addition to §7).
const DefaultDirtyKey = "bal:dirty"

// Org roles as stored in organizations.role.
const (
	RoleSuperAdmin = "SUPER_ADMIN"
	RoleReseller   = "RESELLER"
	RoleClient     = "CLIENT"
)

// TagFor returns the balance hash tag for an org: a CLIENT uses its
// reseller's (parent's) id, a RESELLER its own id. SUPER_ADMIN is never
// billed and returns "".
func TagFor(role, orgID, parentID string) string {
	switch role {
	case RoleClient:
		return parentID
	case RoleReseller:
		return orgID
	default:
		return ""
	}
}

func dirtyMember(tag, orgID string) string { return tag + "|" + orgID }

func parseDirtyMember(m string) (tag, orgID string, ok bool) {
	tag, orgID, ok = strings.Cut(m, "|")
	return tag, orgID, ok && tag != "" && orgID != ""
}
