package pipeline

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"
)

// Redis keys shared by the pipeline, dispatcher and DLR processor
// (CONTRACTS §7).

// DispatchStream is the per-route dispatch queue q:dispatch:<route_id>.
func DispatchStream(routeID string) string { return "q:dispatch:" + routeID }

// DispatchStreamPrefix is the common prefix of every dispatch stream.
const DispatchStreamPrefix = "q:dispatch:"

// DispatchGroup is the consumer group of the dispatch streams.
const DispatchGroup = "dispatch"

// DLROutStream is the default client-DLR stream (q:dlr-out).
const DLROutStream = "q:dlr-out"

// MsgKey is the per-message state hash msg:<message_id>.
func MsgKey(messageID string) string { return "msg:" + messageID }

// DLRMapKey is dlrmap:<connection_id>:<smsc_msg_id>; smscID must already be
// normalized (pdu.NormalizeMessageID).
func DLRMapKey(connectionID, smscID string) string { return "dlrmap:" + connectionID + ":" + smscID }

// DLRMapValue encodes "<message_id>|<part_index>|<created_at_unix_ms>".
func DLRMapValue(messageID string, part int, createdMS int64) string {
	return messageID + "|" + strconv.Itoa(part) + "|" + strconv.FormatInt(createdMS, 10)
}

// ParseDLRMapValue decodes a dlrmap value.
func ParseDLRMapValue(v string) (messageID string, part int, createdMS int64, err error) {
	f := strings.Split(v, "|")
	if len(f) != 3 || f[0] == "" {
		return "", 0, 0, fmt.Errorf("pipeline: bad dlrmap value %q", v)
	}
	if part, err = strconv.Atoi(f[1]); err != nil || part < 0 {
		return "", 0, 0, fmt.Errorf("pipeline: bad dlrmap part in %q", v)
	}
	if createdMS, err = strconv.ParseInt(f[2], 10, 64); err != nil {
		return "", 0, 0, fmt.Errorf("pipeline: bad dlrmap timestamp in %q", v)
	}
	return f[0], part, createdMS, nil
}

// Message state hash fields (msg:<id>). The first block is CONTRACTS §7;
// the rest are engine additions used by the dispatcher / DLR forwarder.
const (
	FOrgID        = "org_id"
	FResellerID   = "reseller_id"
	FChannel      = "channel"
	FParts        = "parts"
	FDelivered    = "delivered"
	FFailed       = "failed"
	FCreatedAtMS  = "created_at_ms"
	FClientRef    = "client_ref"
	FSMPPSystemID = "smpp_system_id"

	FSource      = "src"
	FDest        = "dst"
	FRegDelivery = "rd"            // client registered_delivery (SMPP); "1" for HTTP/WEB
	FText20      = "text"          // first 20 characters of the original text (receipts)
	FRouteID     = "route_id"      //
	FPDUs        = "pdus"          // PDUs actually submitted upstream (DLRs expected); defaults to parts
	FConnection  = "connection_id" // connection used
	FSubmittedMS = "submitted_ms"  // submit_sm_resp time
	FDone        = "done"          // "1" once the final status was emitted
	FStatus      = "status"        // final status once done
)

// Leg is one balance debited for a message (refund information).
type Leg struct {
	OrgID  string `json:"org"`
	Amount int64  `json:"amt"`
}

// DispatchJob is the payload of a q:dispatch:<route_id> entry (field "j").
type DispatchJob struct {
	ID        string `json:"id"`
	CreatedMS int64  `json:"ts"`
	OrgID     string `json:"org"`
	Reseller  string `json:"res,omitempty"`
	RouteID   string `json:"route"`
	Channel   string `json:"ch"`

	Source    string `json:"src"`
	SourceTON uint8  `json:"ston"`
	SourceNPI uint8  `json:"snpi"`
	Dest      string `json:"dst"`
	Text      string `json:"text"` // final text (after templating)
	Encoding  string `json:"enc"`  // GSM7 | UCS2
	Parts     int    `json:"parts"`

	// Billing (refunds). Tag is the balance hash tag; Legs in debit order.
	Tag          string `json:"tag,omitempty"`
	Legs         []Leg  `json:"legs,omitempty"`
	ClientRate   int64  `json:"crate"`
	ResellerRate int64  `json:"rrate"`
}

// CreatedAt is the CDR created_at (millisecond precision).
func (j *DispatchJob) CreatedAt() time.Time { return time.UnixMilli(j.CreatedMS).UTC() }

// JobField is the stream entry field carrying the JSON job.
const JobField = "j"

// EncodeJob serializes a job for XADD.
func EncodeJob(j *DispatchJob) (string, error) {
	b, err := json.Marshal(j)
	return string(b), err
}

// DecodeJob parses a stream entry's values.
func DecodeJob(values map[string]any) (*DispatchJob, error) {
	raw, ok := values[JobField].(string)
	if !ok {
		return nil, fmt.Errorf("pipeline: stream entry has no %q field", JobField)
	}
	j := &DispatchJob{}
	if err := json.Unmarshal([]byte(raw), j); err != nil {
		return nil, fmt.Errorf("pipeline: bad job: %w", err)
	}
	if j.ID == "" || j.RouteID == "" || j.Dest == "" || j.CreatedMS == 0 {
		return nil, fmt.Errorf("pipeline: incomplete job %s", raw)
	}
	return j, nil
}
