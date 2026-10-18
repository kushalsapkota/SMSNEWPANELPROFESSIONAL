package metrics

import "time"

func unixNow() int64 { return time.Now().Unix() }

// Engine is the set of metrics every engine component reports into. A nil
// *Engine is not valid; use NewEngine (tests may use NewEngine(NewRegistry())).
type Engine struct {
	Registry *Registry

	// Submission pipeline.
	SubmitTotal   *Counter   // channel, result (accepted | <error_code>)
	SubmitLatency *Histogram // channel
	PartsAccepted *Counter   // channel
	TPSIn         *RateMeter // accepted messages per second (all channels)

	// Dispatcher.
	DispatchTotal    *Counter   // result: submitted | failed | partial
	DispatchFailover *Counter   // failovers to another connection
	UpstreamSubmit   *Counter   // connection, result: ok | error | timeout
	UpstreamLatency  *Histogram // submit_sm -> submit_sm_resp seconds
	TPSOut           *RateMeter // PDUs submitted upstream per second

	// DLR.
	DLRReceived  *Counter // stat (raw final stat word or "unmatched"/"intermediate")
	DLRFinal     *Counter // status (aggregated message status)
	DLRForwarded *Counter // target: smpp | webhook, result

	// Webhooks.
	WebhookAttempts *Counter   // result: ok | error
	WebhookLatency  *Histogram // seconds

	// CDR writer.
	CDRWritten *Counter // op: insert | update
	CDRErrors  *Counter // op
	CDRDropped *Counter // op (gave up)

	// Balances / misc.
	Refunds *Counter // reason
}

// NewEngine registers the engine metrics on reg.
func NewEngine(reg *Registry) *Engine {
	return &Engine{
		Registry:      reg,
		SubmitTotal:   reg.Counter("smsgw_submit_total", "Message submissions by channel and result (accepted or error code).", "channel", "result"),
		SubmitLatency: reg.Histogram("smsgw_submit_duration_seconds", "Time to accept or reject a submission.", nil, "channel"),
		PartsAccepted: reg.Counter("smsgw_submit_parts_total", "SMS segments accepted for delivery.", "channel"),
		TPSIn:         NewRateMeter(nil),

		DispatchTotal:    reg.Counter("smsgw_dispatch_total", "Messages handled by the dispatcher by outcome.", "result"),
		DispatchFailover: reg.Counter("smsgw_dispatch_failover_total", "Failovers to another upstream connection."),
		UpstreamSubmit:   reg.Counter("smsgw_upstream_submit_total", "submit_sm PDUs sent upstream by connection and result.", "connection", "result"),
		UpstreamLatency:  reg.Histogram("smsgw_upstream_submit_duration_seconds", "submit_sm round trip time.", nil),
		TPSOut:           NewRateMeter(nil),

		DLRReceived:  reg.Counter("smsgw_dlr_received_total", "Upstream delivery receipts by stat.", "stat"),
		DLRFinal:     reg.Counter("smsgw_dlr_final_total", "Messages that reached a final DLR status.", "status"),
		DLRForwarded: reg.Counter("smsgw_dlr_forward_total", "Client DLR forwards by target and result.", "target", "result"),

		WebhookAttempts: reg.Counter("smsgw_webhook_attempts_total", "Webhook delivery attempts by result.", "result"),
		WebhookLatency:  reg.Histogram("smsgw_webhook_duration_seconds", "Webhook POST duration.", nil),

		CDRWritten: reg.Counter("smsgw_cdr_written_total", "CDR rows written by operation.", "op"),
		CDRErrors:  reg.Counter("smsgw_cdr_errors_total", "CDR batch write errors by operation.", "op"),
		CDRDropped: reg.Counter("smsgw_cdr_dropped_total", "CDR operations given up on.", "op"),

		Refunds: reg.Counter("smsgw_refunds_total", "Balance refunds by reason.", "reason"),
	}
}
