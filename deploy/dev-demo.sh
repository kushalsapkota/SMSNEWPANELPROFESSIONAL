#!/usr/bin/env bash
# deploy/dev-demo.sh: provision a demo tenant tree on the running dev stack (deploy/dev-up.sh)
# through the public REST API, then prove an SMS round trip end to end:
#   client --HTTP /v1--> api --> engine (route, billing) --SMPP--> smsc-sim --DLR--> engine --> DELIVERED
#   client --SMPP :2775 (smpp-cli)--> engine --> smsc-sim --DLR--> engine --deliver_sm--> client
#
# The first run provisions everything as the admin, the reseller and the client, through the same
# endpoints the panel uses:
#   connection "smsc-sim (dev)" → 127.0.0.1:2776, rate 0.002/part
#   route "Default via smsc-sim" → that connection
#   reseller reseller@smsgw.local (rate 0.004, credit 1000.00), client client@smsgw.local (rate 0.006,
#   credit 100.00), SMPP enabled for both, a client API key and SMPP account demo1/demopw1
# It writes the credentials to deploy/.run/demo.env. Later runs reuse demo.env and only repeat
# the round trip, so this script also works as a smoke test: exit 0 means the message was DELIVERED.
#
# Env: ADMIN_EMAIL / ADMIN_PASSWORD (as for dev-up), API (default http://127.0.0.1:3000),
#      DEMO_TO (default +919876543210; smsc-sim delivers every number except …0000/…1111/…2222)
set -euo pipefail

DEPLOY="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN="$DEPLOY/.run"
API="${API:-http://127.0.0.1:3000}"
ENGINE="${ENGINE:-http://127.0.0.1:8081}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@smsgw.local}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-Admin-Passw0rd!}"
DEMO_TO="${DEMO_TO:-+919876543210}"
DEMO_ENV="$RUN/demo.env"

log() { printf '\033[1;36m[dev-demo]\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31m[dev-demo] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

[[ -s "$RUN/dev.env" ]] || die "deploy/.run/dev.env missing: start the stack with deploy/dev-up.sh"
# shellcheck disable=SC1091
source "$RUN/dev.env"

# call <METHOD> <path> <auth header value|-> [json body] → response body on stdout; dies on non-2xx.
call() {
  local method="$1" path="$2" auth="$3" body="${4:-}" out code
  local args=(-sS -X "$method" -H 'Content-Type: application/json' -w '\n%{http_code}' --max-time 20)
  [[ "$auth" != "-" ]] && args+=(-H "Authorization: $auth")
  [[ -n "$body" ]] && args+=(--data "$body")
  out="$(curl "${args[@]}" "$API$path")" || die "$method $path: connection failed"
  code="${out##*$'\n'}"
  out="${out%$'\n'*}"
  [[ "$code" =~ ^2 ]] || die "$method $path → HTTP $code: $out"
  printf '%s' "$out"
}

login() {  # login <email> <password> → access token
  call POST /api/auth/login - "$(jq -nc --arg e "$1" --arg p "$2" '{email:$e,password:$p}')" | jq -er .access_token
}

if [[ ! -s "$DEMO_ENV" ]]; then
  log "provisioning demo tenants"
  admin="Bearer $(login "$ADMIN_EMAIL" "$ADMIN_PASSWORD")"

  conn_id="$(call POST /api/connections "$admin" '{
    "name":"smsc-sim (dev)","host":"127.0.0.1","port":2776,"system_id":"smsgw","password":"devpass",
    "max_tps":200,"sessions":1,"bind_type":"TRX","request_dlr":true}' | jq -er .id)"
  call PUT "/api/connections/$conn_id/rates" "$admin" '[{"prefix":"","cost_micros":2000}]' >/dev/null
  route_id="$(call POST /api/routes "$admin" '{"name":"Default via smsc-sim","description":"dev-up demo route"}' | jq -er .id)"
  call PUT "/api/routes/$route_id/connections" "$admin" "$(jq -nc --arg c "$conn_id" '[{connection_id:$c,priority:1,weight:100,enabled:true}]')" >/dev/null
  log "connection $conn_id, route $route_id"

  reseller_pw='Reseller-Passw0rd!'
  reseller_id="$(call POST /api/orgs "$admin" "$(jq -nc --arg p "$reseller_pw" \
    '{name:"Demo Reseller",email:"reseller@smsgw.local",password:$p,brand_name:"DemoTel"}')" | jq -er .id)"
  call PUT "/api/orgs/$reseller_id/routes" "$admin" "$(jq -nc --arg r "$route_id" '[{route_id:$r,prefix:"",rate_micros:4000,priority:1,enabled:true}]')" >/dev/null
  call POST "/api/orgs/$reseller_id/balance/topup" "$admin" '{"amount_micros":1000000000,"note":"dev-up demo credit","idempotency_key":"dev-demo-reseller"}' >/dev/null
  # SMPP is off by default for new orgs; the parent turns it on (admin → reseller → client).
  call PATCH "/api/orgs/$reseller_id/channels" "$admin" '{"smpp_enabled":true}' >/dev/null
  log "reseller $reseller_id (reseller@smsgw.local)"

  reseller="Bearer $(login reseller@smsgw.local "$reseller_pw")"
  client_pw='Client-Passw0rd!'
  client_id="$(call POST /api/orgs "$reseller" "$(jq -nc --arg p "$client_pw" \
    '{name:"Demo Client",email:"client@smsgw.local",password:$p}')" | jq -er .id)"
  call PUT "/api/orgs/$client_id/routes" "$reseller" "$(jq -nc --arg r "$route_id" '[{route_id:$r,prefix:"",rate_micros:6000,priority:1,enabled:true}]')" >/dev/null
  call POST "/api/orgs/$client_id/balance/topup" "$reseller" '{"amount_micros":100000000,"note":"dev-up demo credit","idempotency_key":"dev-demo-client"}' >/dev/null
  call PATCH "/api/orgs/$client_id/channels" "$reseller" '{"smpp_enabled":true}' >/dev/null
  log "client $client_id (client@smsgw.local)"

  client="Bearer $(login client@smsgw.local "$client_pw")"
  api_key="$(call POST /api/api-keys "$client" '{"name":"dev-demo"}' | jq -er .key)"
  smpp_system_id=demo1 smpp_password=demopw1
  call POST /api/smpp-accounts "$client" "$(jq -nc --arg s "$smpp_system_id" --arg p "$smpp_password" '{system_id:$s,password:$p}')" >/dev/null

  umask 077
  cat >"$DEMO_ENV" <<EOF
# written by deploy/dev-demo.sh (dev only)
DEMO_CONNECTION_ID=$conn_id
DEMO_ROUTE_ID=$route_id
DEMO_RESELLER_ID=$reseller_id
DEMO_RESELLER_EMAIL=reseller@smsgw.local
DEMO_RESELLER_PASSWORD='$reseller_pw'
DEMO_CLIENT_ID=$client_id
DEMO_CLIENT_EMAIL=client@smsgw.local
DEMO_CLIENT_PASSWORD='$client_pw'
DEMO_API_KEY=$api_key
DEMO_SMPP_SYSTEM_ID=$smpp_system_id
DEMO_SMPP_PASSWORD=$smpp_password
EOF
  umask 022
fi
# shellcheck disable=SC1090
source "$DEMO_ENV"

# The engine picks up the new connection on cfg:invalidate; wait until it has bound to the sim.
log "waiting for the engine to bind upstream connection $DEMO_CONNECTION_ID"
state=""
for ((i = 0; i < 60; i++)); do
  state="$(curl -fsS --max-time 2 -H "X-Internal-Token: $INTERNAL_TOKEN" "$ENGINE/internal/v1/connections/status" 2>/dev/null \
    | jq -r --arg c "$DEMO_CONNECTION_ID" '.connections[] | select(.connection_id == $c) | .state' 2>/dev/null || true)"
  [[ "$state" == BOUND ]] && break
  sleep 0.5
done
[[ "$state" == BOUND ]] || die "upstream connection not BOUND after 30s (state: ${state:-unknown}); see deploy/.run/logs/engine.log"

log "sending a test SMS via POST /v1/sms/send"
resp="$(call POST /v1/sms/send "Bearer $DEMO_API_KEY" "$(jq -nc --arg to "$DEMO_TO" \
  '{to:$to,from:"DEMO",text:"Your dev-up verification code is 482913",client_ref:"dev-demo"}')")"
msg_id="$(jq -er '.messages[0].message_id' <<<"$resp")" || die "send rejected: $resp"
log "accepted message $msg_id ($(jq -c '.messages[0] | {status,parts,cost_micros}' <<<"$resp"))"

status=""
for ((i = 0; i < 60; i++)); do
  status="$(call GET "/v1/sms/$msg_id" "Bearer $DEMO_API_KEY" 2>/dev/null | jq -r .status 2>/dev/null || true)"
  case "$status" in
    DELIVERED) break ;;
    UNDELIVERED|FAILED|REJECTED|EXPIRED|UNKNOWN) die "message $msg_id ended $status" ;;
  esac
  sleep 0.5
done
[[ "$status" == DELIVERED ]] || die "message $msg_id not delivered after 30s (status: ${status:-unknown})"

# Same round trip over the client SMPP server (bind TRX, submit_sm, wait for deliver_sm receipt).
if [[ -x "$RUN/bin/smpp-cli" ]]; then
  log "sending a test SMS via SMPP (smpp-cli, system_id $DEMO_SMPP_SYSTEM_ID)"
  smpp_out=""
  for ((i = 0; i < 10; i++)); do   # the engine picks up the new account/channel on its next reload
    smpp_out="$("$RUN/bin/smpp-cli" -addr 127.0.0.1:2775 -system-id "$DEMO_SMPP_SYSTEM_ID" -password "$DEMO_SMPP_PASSWORD" \
      -from DEMO -to "$DEMO_TO" -text "SMPP dev-up check 773311" -wait 20s 2>&1 || true)"
    jq -e '.bound' <<<"$smpp_out" >/dev/null 2>&1 && break
    sleep 1
  done
  jq -e '.ok and .dlr.stat == "DELIVRD"' <<<"$smpp_out" >/dev/null 2>&1 \
    || die "SMPP round trip failed: $smpp_out"
  log "SMPP message $(jq -r .message_id <<<"$smpp_out") DELIVERED (receipt stat:DELIVRD)"
fi

balance="$(call GET /v1/balance "Bearer $DEMO_API_KEY" | jq -c .)"
log "message $msg_id DELIVERED (DLR from smsc-sim); client balance $balance"
log "demo logins: reseller@smsgw.local / $DEMO_RESELLER_PASSWORD, client@smsgw.local / $DEMO_CLIENT_PASSWORD"
