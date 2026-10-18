// Package dlr turns upstream delivery receipts into message outcomes and
// forwards them to clients.
//
// Processor (upstream side): a deliver_sm receipt (text form, or TLVs
// receipted_message_id 0x001E / message_state 0x0427) is matched through
// dlrmap:<connection_id>:<smsc_msg_id> to (message, part). Part outcomes are
// aggregated atomically in the msg:<id> hash; once every submitted part is
// final the message status is DELIVERED if all parts were delivered, else
// the worst part status. The CDR is updated and an event is appended to
// q:dlr-out.
//
// Forwarder (client side): consumes q:dlr-out and delivers a deliver_sm
// receipt to the client's bound RX/TRX SMPP session (retried while none is
// bound) and enqueues signed webhook POSTs.
package dlr

import (
	"context"
	"fmt"
	"strconv"

	"github.com/redis/go-redis/v9"

	"smsgw/engine/internal/cdr"
	"smsgw/engine/internal/pipeline"
)

// Part statuses used in the aggregation (message statuses plus FAILED for
// parts rejected at submission).
var severity = map[string]int{
	cdr.StatusDelivered:   0,
	cdr.StatusUnknown:     1,
	cdr.StatusExpired:     2,
	cdr.StatusUndelivered: 3,
	cdr.StatusRejected:    4,
	cdr.StatusFailed:      5,
}

// recordSrc records one part outcome.
//
// KEYS[1] msg:<id>
// ARGV    part index, part status, dlr stat, dlr err
//
// Returns {1,'PARTIAL',delivered,failed} | {1,'FINAL',status,stat,err,delivered,failed} |
// {0,'NO_MSG'} | {0,'DONE'} | {0,'DUP'}
var recordScript = redis.NewScript(`
local k = KEYS[1]
if redis.call('EXISTS', k) == 0 then return {0, 'NO_MSG'} end
if redis.call('HGET', k, 'done') then return {0, 'DONE'} end
local idx = ARGV[1]
if redis.call('HSETNX', k, 's' .. idx, ARGV[2]) == 0 then return {0, 'DUP'} end
redis.call('HSET', k, 'e' .. idx, ARGV[3] .. '|' .. ARGV[4])
if ARGV[2] == 'DELIVERED' then
  redis.call('HINCRBY', k, 'delivered', 1)
else
  redis.call('HINCRBY', k, 'failed', 1)
end
local n = tonumber(redis.call('HGET', k, 'pdus') or redis.call('HGET', k, 'parts') or '1') or 1
local d = tonumber(redis.call('HGET', k, 'delivered') or '0')
local f = tonumber(redis.call('HGET', k, 'failed') or '0')
if d + f < n then
  return {1, 'PARTIAL', tostring(d), tostring(f)}
end
local sev = {DELIVERED = 0, UNKNOWN = 1, EXPIRED = 2, UNDELIVERED = 3, REJECTED = 4, FAILED = 5}
local worst, wi = nil, nil
for i = 0, n - 1 do
  local s = redis.call('HGET', k, 's' .. i)
  if s then
    if worst == nil or (sev[s] or 1) > (sev[worst] or 1) then worst = s; wi = i end
  end
end
if worst == nil then worst = ARGV[2]; wi = idx end
local e = redis.call('HGET', k, 'e' .. wi) or '|'
redis.call('HSET', k, 'done', 1, 'status', worst)
return {1, 'FINAL', worst, e, tostring(d), tostring(f)}`)

// Outcome kinds of RecordPart.
const (
	OutcomePartial = "PARTIAL"
	OutcomeFinal   = "FINAL"
	OutcomeNoMsg   = "NO_MSG"
	OutcomeDone    = "DONE"
	OutcomeDup     = "DUP"
)

// Outcome is the result of recording one part.
type Outcome struct {
	Kind      string
	Status    string // FINAL: aggregated message status
	DLRStat   string // FINAL: stat of the worst part
	DLRErr    string // FINAL: err of the worst part
	Delivered int
	Failed    int
}

// RecordPart records the outcome of part (0-based) of message msgID.
func RecordPart(ctx context.Context, rdb redis.Scripter, msgID string, part int, status, stat, errCode string) (Outcome, error) {
	if _, ok := severity[status]; !ok {
		return Outcome{}, fmt.Errorf("dlr: invalid part status %q", status)
	}
	raw, err := recordScript.Run(ctx, rdb, []string{pipeline.MsgKey(msgID)}, part, status, stat, errCode).Slice()
	if err != nil {
		return Outcome{}, fmt.Errorf("dlr: record part: %w", err)
	}
	if len(raw) < 2 {
		return Outcome{}, fmt.Errorf("dlr: unexpected reply %v", raw)
	}
	kind, _ := raw[1].(string)
	o := Outcome{Kind: kind}
	str := func(i int) string {
		if i < len(raw) {
			s, _ := raw[i].(string)
			return s
		}
		return ""
	}
	switch kind {
	case OutcomePartial:
		o.Delivered, _ = strconv.Atoi(str(2))
		o.Failed, _ = strconv.Atoi(str(3))
	case OutcomeFinal:
		o.Status = str(2)
		e := str(3)
		for i := 0; i < len(e); i++ {
			if e[i] == '|' {
				o.DLRStat, o.DLRErr = e[:i], e[i+1:]
				break
			}
		}
		o.Delivered, _ = strconv.Atoi(str(4))
		o.Failed, _ = strconv.Atoi(str(5))
	case OutcomeNoMsg, OutcomeDone, OutcomeDup:
	default:
		return Outcome{}, fmt.Errorf("dlr: unexpected outcome %v", raw)
	}
	return o, nil
}

// StatusForStat maps a normalized receipt stat to a message status
// (CONTRACTS §9). final=false for ACCEPTD / ENROUTE (not final) and "".
// Unrecognized words are treated as a final UNKNOWN.
func StatusForStat(stat string) (status string, final bool) {
	switch stat {
	case "DELIVRD":
		return cdr.StatusDelivered, true
	case "UNDELIV":
		return cdr.StatusUndelivered, true
	case "EXPIRED":
		return cdr.StatusExpired, true
	case "REJECTD":
		return cdr.StatusRejected, true
	case "DELETED", "UNKNOWN":
		return cdr.StatusUnknown, true
	case "ACCEPTD", "ENROUTE", "":
		return "", false
	}
	return cdr.StatusUnknown, true
}

// StatForStatus is the receipt stat word sent to clients for a status.
func StatForStatus(status string) string {
	switch status {
	case cdr.StatusDelivered:
		return "DELIVRD"
	case cdr.StatusUndelivered:
		return "UNDELIV"
	case cdr.StatusExpired:
		return "EXPIRED"
	case cdr.StatusRejected, cdr.StatusFailed:
		return "REJECTD"
	}
	return "UNKNOWN"
}

// normalizeErr renders a receipt err field as the 3-character dlr_err.
func normalizeErr(e string) string {
	if e == "" {
		return "000"
	}
	if len(e) > 3 {
		return e[len(e)-3:]
	}
	for len(e) < 3 {
		e = "0" + e
	}
	return e
}
