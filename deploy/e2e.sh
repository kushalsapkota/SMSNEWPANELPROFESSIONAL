#!/usr/bin/env bash
# deploy/e2e.sh: end-to-end business scenario against a LIVE stack (api, engine, web, two
# smsc-sim upstreams, a webhook receiver), asserting every step through the public interfaces.
#
#   deploy/e2e/stack.sh up && deploy/e2e.sh; deploy/e2e/stack.sh down
#   E2E_START_STACK=1 deploy/e2e.sh      # start the isolated stack first, stop it on exit
#
# The stack started by deploy/e2e/stack.sh uses DB sms_e2e, Redis DB 3 and non-default ports so
# it can run next to deploy/dev-up.sh. Every endpoint comes from env (defaults in brackets):
#   E2E_API_PORT [3100]  E2E_WEB_PORT [3101]  E2E_ENGINE_PORT [8181]  E2E_SMPP_PORT [2875]
#   E2E_SIM1_PORT [2876]  E2E_SIM1_HTTP [2877]  E2E_SIM2_PORT [2886]  E2E_SIM2_HTTP [2887]
#   E2E_HOOK_PORT [2899]  E2E_SKIP_WEB [0]  ADMIN_EMAIL / ADMIN_PASSWORD (seeded admin)
#   E2E_SMPP_CLI (default deploy/e2e/.run/bin/smpp-cli)
#   E2E_INTERNAL_TOKEN (default: from deploy/e2e/.run/secrets.env; used only for the upstream
#                       bind check)
#
# Scenario (each step asserts; the first failure exits non-zero with the offending response):
#   1  admin: two upstream connections (sim1, sim2), rates, template route OTP (sim1 prio 1,
#      sim2 prio 2, route-wide template, fallback REJECT), plain route BULK
#   2  admin: reseller R (OTP 3000 micros), top-up; admin has read-only view of R's clients
#   3  R: client C (OTP 5000), top-up, brand, API key, SMPP account, webhook, IP whitelist
#   4  C: /v1 OTP send → templated text at sim1, DLR → DELIVERED, signed webhook, both balances
#   5  no OTP → 422 OTP_NOT_FOUND, no charge
#   6  Unicode long text on BULK → multipart, parts and per-part charge
#   7  …1111 on OTP → sim1 rejects, failover to sim2 delivers
#   8  SMPP: smpp-cli binds as C, submits, receives the deliver_sm receipt
#   9  R stops C's sending (HTTP + SMPP rejected, live session kicked), re-enables; suspends C
#   10 IP whitelist 10.0.0.0/8 only → IP_NOT_ALLOWED from localhost
#   11 R cannot reach another reseller's client
#   12 reports: message list, analytics summary from rollups, CSV export
#   13 web: login + main pages answer 200 (and the web proxies /api to the api)
set -Eeuo pipefail

DEPLOY="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
E2E_RUN="$DEPLOY/e2e/.run"
[[ -f "$E2E_RUN/stack.env" && -z "${E2E_API_PORT:-}" ]] && { set -a; source "$E2E_RUN/stack.env"; set +a; }

API_PORT="${E2E_API_PORT:-3100}"
WEB_PORT="${E2E_WEB_PORT:-3101}"
ENGINE_PORT="${E2E_ENGINE_PORT:-8181}"
SMPP_PORT="${E2E_SMPP_PORT:-2875}"
SIM1_PORT="${E2E_SIM1_PORT:-2876}"
SIM1_HTTP="${E2E_SIM1_HTTP:-2877}"
SIM2_PORT="${E2E_SIM2_PORT:-2886}"
SIM2_HTTP="${E2E_SIM2_HTTP:-2887}"
HOOK_PORT="${E2E_HOOK_PORT:-2899}"
SKIP_WEB="${E2E_SKIP_WEB:-0}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@smsgw.local}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-Admin-Passw0rd!}"
SMPP_CLI="${E2E_SMPP_CLI:-$E2E_RUN/bin/smpp-cli}"

API="http://127.0.0.1:$API_PORT"
WEB="http://127.0.0.1:$WEB_PORT"
ENGINE="http://127.0.0.1:$ENGINE_PORT"
SIM1="http://127.0.0.1:$SIM1_HTTP"
SIM2="http://127.0.0.1:$SIM2_HTTP"
HOOK="http://127.0.0.1:$HOOK_PORT"

if ! command -v jq >/dev/null; then
  echo "[e2e] jq missing; installing" >&2
  (apt-get update -qq && apt-get install -y -qq jq) >/dev/null
fi
for c in curl jq openssl; do command -v "$c" >/dev/null || { echo "[e2e] $c not found" >&2; exit 1; }; done

if [[ "${E2E_START_STACK:-0}" == 1 ]]; then
  "$DEPLOY/e2e/stack.sh" up
  trap '"$DEPLOY/e2e/stack.sh" down' EXIT
  set -a; source "$E2E_RUN/stack.env"; set +a
fi
if [[ -z "${E2E_INTERNAL_TOKEN:-}" && -f "$E2E_RUN/secrets.env" ]]; then
  E2E_INTERNAL_TOKEN="$(sed -n 's/^INTERNAL_TOKEN=//p' "$E2E_RUN/secrets.env")"
fi

# --- output & assertions ---------------------------------------------------------------------
STEP="" PASSED=0
TMP="$(mktemp -d)"
cleanup_tmp() { rm -rf "$TMP"; [[ -n "${KICK_PID:-}" ]] && kill "$KICK_PID" 2>/dev/null; return 0; }
trap 'cleanup_tmp' EXIT
[[ "${E2E_START_STACK:-0}" == 1 ]] && trap 'cleanup_tmp; "$DEPLOY/e2e/stack.sh" down' EXIT

step() { STEP="$*"; printf '\n\033[1;36m== %s\033[0m\n' "$*" >&2; }
ok()   { PASSED=$((PASSED + 1)); printf '  \033[32mok\033[0m  %s\n' "$*" >&2; }
fail() {
  printf '  \033[1;31mFAIL\033[0m [%s] %s\n' "$STEP" "$*" >&2
  [[ -n "${BODY:-}" ]] && printf '       last response (HTTP %s): %s\n' "${CODE:-?}" "$(head -c 1500 <<<"$BODY")" >&2
  exit 1
}

# req <METHOD> <url-or-/path> <auth: token|key:<k>|-> [json body]  → sets CODE, BODY
CODE="" BODY=""
req() {
  local method="$1" url="$2" auth="$3" body="${4:-}"
  [[ "$url" == /* ]] && url="$API$url"
  local args=(-sS -X "$method" -o "$TMP/body" -w '%{http_code}' --max-time 30 -H 'Content-Type: application/json')
  case "$auth" in
    -) ;;
    key:*) args+=(-H "Authorization: Bearer ${auth#key:}") ;;
    *) args+=(-H "Authorization: Bearer $auth") ;;
  esac
  [[ -n "$body" ]] && args+=(--data "$body")
  CODE="$(curl "${args[@]}" "$url" 2>"$TMP/err")" || CODE="000"
  BODY="$(cat "$TMP/body" 2>/dev/null || true)"
  [[ "$CODE" == 000 ]] && BODY="curl: $(cat "$TMP/err")"
  return 0
}
expect_code() {  # expect_code <regex> <what>
  [[ "$CODE" =~ ^($1)$ ]] || fail "$2: expected HTTP $1, got $CODE"
}
jqb() { jq -r "$@" <<<"$BODY"; }
expect_jq() {  # expect_jq <jq filter returning true> <what>
  jq -e "$1" <<<"$BODY" >/dev/null 2>&1 || fail "$2 (check: $1)"
}
call() {  # call <METHOD> <path> <auth> [body]: request that must succeed (2xx)
  req "$@"
  [[ "$CODE" =~ ^2 ]] || fail "$1 $2 expected 2xx, got $CODE"
}
login() {  # login <email> <password> → access token on stdout
  req POST /api/auth/login - "$(jq -nc --arg e "$1" --arg p "$2" '{email:$e,password:$p}')"
  [[ "$CODE" == 200 ]] || fail "login $1: HTTP $CODE"
  jqb .access_token
}
# wait_for <timeout_s> <description> <command...>: retry the command every 0.5s until it succeeds.
wait_for() {
  local timeout="$1" what="$2"; shift 2
  local i
  for ((i = 0; i < timeout * 2; i++)); do
    "$@" && return 0
    sleep 0.5
  done
  fail "timed out after ${timeout}s waiting for: $what"
}

balance_of() {  # balance_of <token> <org_id> → balance_micros (live engine value when loaded)
  req GET "/api/orgs/$2/balance" "$1"
  [[ "$CODE" == 200 ]] || fail "GET balance of $2: HTTP $CODE"
  jqb .balance_micros
}
sim_messages() {  # sim_messages <sim base url> <dest> → JSON array (newest first)
  curl -fsS --max-time 5 "$1/messages?dest=$2" | jq -c '.messages'
}
v1_status() {  # v1_status <api key> <message id> → status
  req GET "/v1/sms/$2" "key:$1"
  jqb '.status // empty'
}
msg_final() {  # msg_final <api key> <message id> <wanted status>
  local s; s="$(v1_status "$1" "$2")"
  [[ "$s" == "$3" ]] && return 0
  case "$s" in DELIVERED|UNDELIVERED|FAILED|REJECTED|EXPIRED|UNKNOWN) fail "message $2 ended $s, wanted $3" ;; esac
  return 1
}
hmac_hex() {  # hmac_hex <secret> <data>
  printf '%s' "$2" | openssl dgst -sha256 -hmac "$1" -hex | sed 's/^.*= //'
}

RUN_ID="$(date +%s)$RANDOM"
mail() { echo "$1-$RUN_ID@e2e.test"; }
DEST_OTP="9198765$(printf '%05d' $((RANDOM % 99999)))"
[[ "$DEST_OTP" == *0000 || "$DEST_OTP" == *1111 || "$DEST_OTP" == *2222 ]] && DEST_OTP=919876543210
DEST_FAILOVER="9198$(printf '%04d' $((RANDOM % 9999)))1111"
DEST_BULK="4477009$(printf '%05d' $((RANDOM % 99999)))"
[[ "$DEST_BULK" == *0000 || "$DEST_BULK" == *1111 || "$DEST_BULK" == *2222 ]] && DEST_BULK=447700900123
DEST_SMPP="9197765$(printf '%05d' $((RANDOM % 99999)))"
[[ "$DEST_SMPP" == *0000 || "$DEST_SMPP" == *1111 || "$DEST_SMPP" == *2222 ]] && DEST_SMPP=919776543210
DEST_KICK="9196$(printf '%04d' $((RANDOM % 9999)))2222"
BRAND="AcmeBank"
TEMPLATE_BODY='Your verification code is {otp}. Valid for 10 minutes. -{brand}'

printf '[e2e] api %s  web %s  engine %s  smpp :%s  sims %s %s  hooks %s\n' "$API" "$WEB" "$ENGINE" "$SMPP_PORT" "$SIM1" "$SIM2" "$HOOK" >&2
req GET /api/health -
[[ "$CODE" == 200 ]] || fail "api not healthy at $API (HTTP $CODE); start it with deploy/e2e/stack.sh up"
curl -fsS --max-time 3 "$SIM1/health" >/dev/null || fail "smsc-sim 1 not reachable at $SIM1"
curl -fsS --max-time 3 "$SIM2/health" >/dev/null || fail "smsc-sim 2 not reachable at $SIM2"
curl -fsS --max-time 3 "$HOOK/health" >/dev/null || fail "webhook receiver not reachable at $HOOK"
[[ -x "$SMPP_CLI" ]] || fail "smpp-cli not found at $SMPP_CLI (set E2E_SMPP_CLI)"

# ============================================================================================
step "1. admin: connections, rates, routes OTP (template, failover) and BULK"
ADMIN="$(login "$ADMIN_EMAIL" "$ADMIN_PASSWORD")"
ok "admin logged in"
req GET /api/auth/me "$ADMIN"; expect_code 200 "me"; expect_jq '.org.role == "SUPER_ADMIN"' "admin acting role"

call POST /api/connections "$ADMIN" "$(jq -nc --arg n "sim1-$RUN_ID" --arg id "${RUN_ID: -10}" --argjson p "$SIM1_PORT" \
  '{name:$n,host:"127.0.0.1",port:$p,system_id:("a" + $id),password:"pw1",max_tps:200,sessions:1,bind_type:"TRX",request_dlr:true,submit_timeout_ms:5000}')"
CONN1="$(jqb .id)"
expect_jq '(has("password") or has("password_enc")) | not' "connection response never returns the password"
call POST /api/connections "$ADMIN" "$(jq -nc --arg n "sim2-$RUN_ID" --arg id "${RUN_ID: -10}" --argjson p "$SIM2_PORT" \
  '{name:$n,host:"127.0.0.1",port:$p,system_id:("b" + $id),password:"pw2",max_tps:200,sessions:1,bind_type:"TRX",request_dlr:true,submit_timeout_ms:5000}')"
CONN2="$(jqb .id)"
call PUT "/api/connections/$CONN1/rates" "$ADMIN" '[{"prefix":"","cost_micros":1000},{"prefix":"91","cost_micros":1200}]'
call PUT "/api/connections/$CONN2/rates" "$ADMIN" '[{"prefix":"","cost_micros":1500}]'
ok "connections sim1=$CONN1 sim2=$CONN2 with rates"

call POST /api/routes "$ADMIN" "$(jq -nc --arg n "OTP-$RUN_ID" '{name:$n,description:"OTP template route",template_mode:true,template_fallback:"REJECT"}')"
ROUTE_OTP="$(jqb .id)"
expect_jq '.template_mode == true and .template_fallback == "REJECT"' "OTP route is template-mode with REJECT fallback"
call PUT "/api/routes/$ROUTE_OTP/connections" "$ADMIN" "$(jq -nc --arg a "$CONN1" --arg b "$CONN2" \
  '[{connection_id:$a,priority:1,weight:100,enabled:true},{connection_id:$b,priority:2,weight:100,enabled:true}]')"
call POST /api/templates "$ADMIN" "$(jq -nc --arg r "$ROUTE_OTP" --arg b "$TEMPLATE_BODY" \
  '{route_id:$r,name:"OTP default",template_body:$b,fallback_action:"REJECT"}')"
TEMPLATE_ID="$(jqb .id)"
expect_jq '.org_id == null' "admin template is route-wide"
call POST /api/routes "$ADMIN" "$(jq -nc --arg n "BULK-$RUN_ID" '{name:$n,description:"plain bulk route"}')"
ROUTE_BULK="$(jqb .id)"
call PUT "/api/routes/$ROUTE_BULK/connections" "$ADMIN" "$(jq -nc --arg a "$CONN1" '[{connection_id:$a,priority:1,weight:100,enabled:true}]')"
ok "routes OTP=$ROUTE_OTP (template $TEMPLATE_ID) BULK=$ROUTE_BULK"

conns_bound() {
  req GET /api/monitor/connections "$ADMIN"
  [[ "$CODE" == 200 ]] || return 1
  jq -e --arg a "$CONN1" --arg b "$CONN2" \
    '[.connections[] | select(.connection_id == $a or .connection_id == $b) | select(.state == "BOUND")] | length == 2' <<<"$BODY" >/dev/null
}
wait_for 30 "engine bound to both upstream connections" conns_bound
ok "engine bound to sim1 and sim2 (GET /api/monitor/connections)"

req POST /api/templates/preview "$ADMIN" "$(jq -nc --arg r "$ROUTE_OTP" '{text:"Ur code 849201 is valid for login",route_id:$r}')"
expect_code 200 "template preview"
expect_jq '.otp == "849201" and .action == "TEMPLATED"' "preview extracts the OTP"
ok "template preview: $(jqb .output)"

# ============================================================================================
step "2. admin: reseller R, route rates, top-up"
R_EMAIL="$(mail reseller)" R_PASS='Reseller-E2e-Pass1!'
call POST /api/orgs "$ADMIN" "$(jq -nc --arg e "$R_EMAIL" --arg p "$R_PASS" '{name:"E2E Reseller",email:$e,password:$p,brand_name:"ResellerTel",max_tps:50}')"
R_ID="$(jqb .id)"
expect_jq '.role == "RESELLER"' "admin creates a RESELLER"
call PUT "/api/orgs/$R_ID/routes" "$ADMIN" "$(jq -nc --arg o "$ROUTE_OTP" --arg b "$ROUTE_BULK" \
  '[{route_id:$o,prefix:"",rate_micros:3000,priority:1,enabled:true},{route_id:$b,prefix:"",rate_micros:2000,priority:1,enabled:true}]')"
call POST "/api/orgs/$R_ID/balance/topup" "$ADMIN" "$(jq -nc --arg k "e2e-r-$RUN_ID" '{amount_micros:50000000,note:"e2e reseller credit",idempotency_key:$k}')"
call PATCH "/api/orgs/$R_ID/channels" "$ADMIN" '{"smpp_enabled":true}'
[[ "$(balance_of "$ADMIN" "$R_ID")" == 50000000 ]] || fail "reseller balance after top-up is not 50000000"
ok "reseller R=$R_ID, OTP rate 3000, BULK rate 2000, balance 50.000000"

# ============================================================================================
step "3. R: client C, rates, credit, brand, API key, SMPP account, webhook, IP whitelist"
R_TOKEN="$(login "$R_EMAIL" "$R_PASS")"
C_EMAIL="$(mail client)" C_PASS='Client-E2e-Pass1!'
call POST /api/orgs "$R_TOKEN" "$(jq -nc --arg e "$C_EMAIL" --arg p "$C_PASS" '{name:"E2E Client",email:$e,password:$p,max_tps:20}')"
C_ID="$(jqb .id)"
expect_jq '.role == "CLIENT"' "reseller creates a CLIENT"
expect_jq "$(printf '.parent_id == "%s"' "$R_ID")" "client is a child of R"
# OTP for India (91), BULK for UK (44): /v1 has no route selector, the destination prefix decides.
call PUT "/api/orgs/$C_ID/routes" "$R_TOKEN" "$(jq -nc --arg o "$ROUTE_OTP" --arg b "$ROUTE_BULK" \
  '[{route_id:$o,prefix:"91",rate_micros:5000,priority:1,enabled:true},{route_id:$b,prefix:"44",rate_micros:4000,priority:1,enabled:true}]')"
call POST "/api/orgs/$C_ID/balance/topup" "$R_TOKEN" "$(jq -nc --arg k "e2e-c-$RUN_ID" '{amount_micros:10000000,note:"e2e client credit",idempotency_key:$k}')"
call PATCH "/api/orgs/$C_ID" "$R_TOKEN" "$(jq -nc --arg b "$BRAND" '{brand_name:$b}')"
expect_jq "$(printf '.brand_name == "%s"' "$BRAND")" "brand set"
call PATCH "/api/orgs/$C_ID/channels" "$R_TOKEN" '{"smpp_enabled":true}'
call POST "/api/api-keys?org_id=$C_ID" "$R_TOKEN" '{"name":"e2e key"}'
C_KEY="$(jqb .key)"
[[ "$C_KEY" =~ ^sk_live_[A-Za-z0-9]{40}$ ]] || fail "API key format"
SMPP_SYS="e2e${RUN_ID: -6}" SMPP_PW="e2epw1"
call POST "/api/smpp-accounts?org_id=$C_ID" "$R_TOKEN" "$(jq -nc --arg s "$SMPP_SYS" --arg p "$SMPP_PW" '{system_id:$s,password:$p}')"
SMPP_ACC_ID="$(jqb .id)"
expect_jq '(has("password") or has("password_hash")) | not' "SMPP account never returns the password"
call POST "/api/webhooks?org_id=$C_ID" "$R_TOKEN" "$(jq -nc --arg u "$HOOK/hook/$RUN_ID" '{url:$u,events:["dlr"],max_retries:3}')"
WEBHOOK_ID="$(jqb .id)" WEBHOOK_SECRET="$(jqb .secret)"
[[ -n "$WEBHOOK_SECRET" && "$WEBHOOK_SECRET" != null ]] || fail "webhook secret returned once on create"
call POST "/api/ip-whitelist?org_id=$C_ID" "$R_TOKEN" '{"cidr":"127.0.0.1","scope":"API","note":"e2e localhost"}'
IPW_ID="$(jqb .id)"
expect_jq '.cidr == "127.0.0.1/32"' "bare IP stored as /32"
ok "client C=$C_ID (OTP 5000/91, BULK 4000/44), brand $BRAND, key ${C_KEY:0:12}…, smpp $SMPP_SYS, webhook, whitelist 127.0.0.1/32"

# admin: read-only on the reseller's client
req GET "/api/orgs/$C_ID" "$ADMIN"; expect_code 200 "admin reads R's client"
req GET "/api/api-keys?org_id=$C_ID" "$ADMIN"; expect_code 200 "admin lists the client's API keys (read)"
expect_jq '[.items[] | has("key") or has("key_hash")] | any | not' "admin sees no key material"
req GET "/api/smpp-accounts?org_id=$C_ID" "$ADMIN"; expect_code 200 "admin lists the client's SMPP accounts (read)"
expect_jq '[.items[] | has("password_hash") or has("password")] | any | not' "admin sees no SMPP password"
req GET "/api/webhooks?org_id=$C_ID" "$ADMIN"; expect_code 200 "admin lists the client's webhooks (read)"
expect_jq '[.items[] | has("secret") or has("secret_enc")] | any | not' "admin sees no webhook secret"
req POST "/api/api-keys?org_id=$C_ID" "$ADMIN" '{"name":"admin-sneak"}'; expect_code '403|404' "admin cannot create credentials for R's client"
req PATCH "/api/orgs/$C_ID/channels" "$ADMIN" '{"sending_enabled":false}'; expect_code '403|404' "admin cannot change R's client"
req POST "/api/webhooks/$WEBHOOK_ID/test" "$ADMIN"; expect_code '403|404' "admin cannot fire R's client's webhook"
ok "admin: read-only access to the client, no secrets, writes refused"

# ============================================================================================
step "4. C: OTP via POST /v1/sms/send → template, DLR, webhook, billing"
C_BAL0="$(balance_of "$R_TOKEN" "$C_ID")"
R_BAL0="$(balance_of "$ADMIN" "$R_ID")"
[[ "$C_BAL0" == 10000000 ]] || fail "client balance before send is $C_BAL0, want 10000000"
OTP_TEXT='Ur code 849201 is valid for login'
EXPECT_SENT="Your verification code is 849201. Valid for 10 minutes. -$BRAND"
req POST /v1/sms/send "key:$C_KEY" "$(jq -nc --arg to "+$DEST_OTP" --arg t "$OTP_TEXT" --arg ref "otp-$RUN_ID" '{to:$to,from:"ACME",text:$t,client_ref:$ref}')"
expect_code 200 "/v1 send"
expect_jq '.messages | length == 1' "one result"
expect_jq '.messages[0].status == "ACCEPTED" and .messages[0].parts == 1 and .messages[0].cost_micros == 5000' "accepted, 1 part, 5000 micros"
MSG_OTP="$(jqb '.messages[0].message_id')"
ok "accepted $MSG_OTP"

sim1_has_otp() { sim_messages "$SIM1" "$DEST_OTP" | jq -e 'length >= 1' >/dev/null 2>&1; }
wait_for 20 "sim1 receives the OTP message" sim1_has_otp
SIMREC="$(sim_messages "$SIM1" "$DEST_OTP" | jq -c '.[0]')"
[[ "$(jq -r .text <<<"$SIMREC")" == "$EXPECT_SENT" ]] || fail "sim1 text: $(jq -r .text <<<"$SIMREC") != $EXPECT_SENT"
[[ "$(jq -r .source <<<"$SIMREC")" == ACME ]] || fail "sim1 source: $(jq -r .source <<<"$SIMREC")"
jq -e '.source_ton == 5 and .dest_ton == 1 and .registered_delivery == 1' <<<"$SIMREC" >/dev/null || fail "sim1 TON/NPI/registered_delivery: $SIMREC"
[[ "$(sim_messages "$SIM2" "$DEST_OTP" | jq length)" == 0 ]] || fail "sim2 must not receive the OTP message (priority 2)"
ok "sim1 received exactly: $EXPECT_SENT"

wait_for 30 "message $MSG_OTP DELIVERED" msg_final "$C_KEY" "$MSG_OTP" DELIVERED
req GET "/v1/sms/$MSG_OTP" "key:$C_KEY"
expect_jq "$(printf '.status == "DELIVERED" and .dlr_stat == "DELIVRD" and .to == "%s" and .from == "ACME" and .client_ref == "otp-%s" and .cost_micros == 5000 and .done_at != null' "$DEST_OTP" "$RUN_ID")" "GET /v1/sms/:id after DLR"
ok "GET /v1/sms/$MSG_OTP → DELIVERED (DELIVRD)"

hook_for_msg() {  # hook_for_msg <message id> → sets HOOK_REC
  HOOK_REC="$(curl -fsS --max-time 5 "$HOOK/events" | jq -c --arg m "$1" '[.[] | select((.body | fromjson? // {}) | .message_id == $m)] | last // empty')"
  [[ -n "$HOOK_REC" ]]
}
wait_for 30 "webhook for $MSG_OTP" hook_for_msg "$MSG_OTP"
H_TS="$(jq -r '.headers["x-webhook-timestamp"]' <<<"$HOOK_REC")"
H_SIG="$(jq -r '.headers["x-webhook-signature"]' <<<"$HOOK_REC")"
H_BODY="$(jq -r .body <<<"$HOOK_REC")"
[[ "$(jq -r .path <<<"$HOOK_REC")" == "/hook/$RUN_ID" ]] || fail "webhook path"
[[ "$H_SIG" == "sha256=$(hmac_hex "$WEBHOOK_SECRET" "$H_TS.$H_BODY")" ]] || fail "webhook signature mismatch: $H_SIG"
NOW="$(date +%s)"; ((NOW - H_TS < 300 && H_TS - NOW < 300)) || fail "webhook timestamp $H_TS not current"
jq -e --arg m "$MSG_OTP" --arg to "$DEST_OTP" --arg ref "otp-$RUN_ID" \
  '.event == "dlr" and .message_id == $m and .to == $to and .from == "ACME" and .status == "DELIVERED" and .dlr_stat == "DELIVRD" and .client_ref == $ref and .parts == 1' \
  <<<"$H_BODY" >/dev/null || fail "webhook payload: $H_BODY"
ok "webhook delivered with valid HMAC signature ($H_SIG)"

req GET /v1/balance "key:$C_KEY"; expect_code 200 "/v1/balance"
[[ "$(jqb .balance_micros)" == $((C_BAL0 - 5000)) ]] || fail "client balance via /v1/balance $(jqb .balance_micros), want $((C_BAL0 - 5000))"
[[ "$(balance_of "$R_TOKEN" "$C_ID")" == $((C_BAL0 - 5000)) ]] || fail "client balance via api"
[[ "$(balance_of "$ADMIN" "$R_ID")" == $((R_BAL0 - 3000)) ]] || fail "reseller balance $(balance_of "$ADMIN" "$R_ID"), want $((R_BAL0 - 3000))"
ok "C charged 5000 (→ $((C_BAL0 - 5000))), R charged 3000 (→ $((R_BAL0 - 3000)))"

# ============================================================================================
step "5. message without an OTP → 422 OTP_NOT_FOUND, no charge"
C_BAL1="$((C_BAL0 - 5000))" R_BAL1="$((R_BAL0 - 3000))"
req POST /v1/sms/send "key:$C_KEY" "$(jq -nc --arg to "$DEST_OTP" '{to:$to,from:"ACME",text:"Hello, your parcel is on its way"}')"
expect_code 422 "no-OTP send"
expect_jq '.error_code == "OTP_NOT_FOUND"' "OTP_NOT_FOUND"
[[ "$(balance_of "$R_TOKEN" "$C_ID")" == "$C_BAL1" ]] || fail "client charged for a rejected message"
[[ "$(balance_of "$ADMIN" "$R_ID")" == "$R_BAL1" ]] || fail "reseller charged for a rejected message"
ok "rejected OTP_NOT_FOUND, balances unchanged"

# ============================================================================================
step "6. Unicode long message on BULK → multipart, charged per part"
UNI_TEXT="Здравствуйте! Ваш заказ №4521 отправлен. Спасибо, что выбрали нас — команда поддержки всегда рядом. Хорошего дня! 😊"
UNI_UNITS="$(printf '%s' "$UNI_TEXT" | iconv -f UTF-8 -t UTF-16LE | wc -c)"; UNI_UNITS=$((UNI_UNITS / 2))
UNI_PARTS=$(( UNI_UNITS <= 70 ? 1 : (UNI_UNITS + 66) / 67 ))
((UNI_PARTS >= 2)) || fail "test text must be multipart (units $UNI_UNITS)"
req POST /v1/sms/send "key:$C_KEY" "$(jq -nc --arg to "$DEST_BULK" --arg t "$UNI_TEXT" '{to:$to,from:"ACME",text:$t}')"
expect_code 200 "unicode send"
expect_jq ".messages[0].parts == $UNI_PARTS and .messages[0].cost_micros == $((4000 * UNI_PARTS))" "parts=$UNI_PARTS cost=$((4000 * UNI_PARTS))"
MSG_UNI="$(jqb '.messages[0].message_id')"
wait_for 30 "unicode message DELIVERED" msg_final "$C_KEY" "$MSG_UNI" DELIVERED
UNIREC="$(sim_messages "$SIM1" "$DEST_BULK" | jq -c '.[0]')"
jq -e --arg t "$UNI_TEXT" --argjson p "$UNI_PARTS" '.text == $t and .parts == $p and .data_coding == 8 and .multipart != ""' <<<"$UNIREC" >/dev/null \
  || fail "sim1 multipart record: $UNIREC"
[[ "$(balance_of "$R_TOKEN" "$C_ID")" == $((C_BAL1 - 4000 * UNI_PARTS)) ]] || fail "client not charged per part"
[[ "$(balance_of "$ADMIN" "$R_ID")" == $((R_BAL1 - 2000 * UNI_PARTS)) ]] || fail "reseller not charged per part"
C_BAL2=$((C_BAL1 - 4000 * UNI_PARTS)) R_BAL2=$((R_BAL1 - 2000 * UNI_PARTS))
ok "$UNI_UNITS UTF-16 units → $UNI_PARTS UCS-2 parts ($(jq -r .multipart <<<"$UNIREC")), reassembled at sim1, C −$((4000 * UNI_PARTS)), R −$((2000 * UNI_PARTS))"

# ============================================================================================
step "7. …1111 on OTP → sim1 rejects, failover to sim2 delivers"
req POST /v1/sms/send "key:$C_KEY" "$(jq -nc --arg to "$DEST_FAILOVER" '{to:$to,from:"ACME",text:"Your OTP is 552211"}')"
expect_code 200 "failover send"
MSG_FO="$(jqb '.messages[0].message_id')"
wait_for 30 "failover message DELIVERED" msg_final "$C_KEY" "$MSG_FO" DELIVERED
sim_messages "$SIM1" "$DEST_FAILOVER" | jq -e '.[0].submit_status == "ESME_RSUBMITFAIL"' >/dev/null || fail "sim1 should have rejected $DEST_FAILOVER"
sim_messages "$SIM2" "$DEST_FAILOVER" | jq -e --arg t "Your verification code is 552211. Valid for 10 minutes. -$BRAND" \
  '.[0].submit_status == "ESME_ROK" and .[0].text == $t' >/dev/null || fail "sim2 did not receive the failover message"
req GET "/api/messages/$MSG_FO" "$ADMIN"; expect_code 200 "admin message detail"
expect_jq "$(printf '.connection_id == "%s"' "$CONN2")" "CDR records sim2 as the connection used"
[[ "$(balance_of "$R_TOKEN" "$C_ID")" == $((C_BAL2 - 5000)) ]] || fail "failover message charged once"
C_BAL3=$((C_BAL2 - 5000)) R_BAL3=$((R_BAL2 - 3000))
ok "sim1 ESME_RSUBMITFAIL → sim2 accepted, DELIVERED, charged once"

# ============================================================================================
step "8. SMPP: smpp-cli binds as C, submits, receives the receipt"
smpp_send() {  # smpp_send <to> <text> [extra args] → SMPP_OUT
  SMPP_OUT="$("$SMPP_CLI" -addr "127.0.0.1:$SMPP_PORT" -system-id "$SMPP_SYS" -password "$SMPP_PW" -from ACME -to "$1" -text "$2" "${@:3}" 2>&1 || true)"
}
smpp_bound_ok() {
  smpp_send "$DEST_SMPP" "Code 731904 for login" -wait 20s
  jq -e '.bound' <<<"$SMPP_OUT" >/dev/null 2>&1
}
wait_for 15 "SMPP bind as $SMPP_SYS" smpp_bound_ok
jq -e '.ok == true and .dlr.stat == "DELIVRD"' <<<"$SMPP_OUT" >/dev/null || fail "smpp-cli: $SMPP_OUT"
MSG_SMPP="$(jq -r .message_id <<<"$SMPP_OUT")"
sim_messages "$SIM1" "$DEST_SMPP" | jq -e --arg t "Your verification code is 731904. Valid for 10 minutes. -$BRAND" '.[0].text == $t' >/dev/null \
  || fail "SMPP message not templated at sim1"
smpp_cdr_delivered() {  # the CDR is written asynchronously (batched), so it may trail the receipt
  req GET "/api/messages/$MSG_SMPP" "$R_TOKEN"
  [[ "$CODE" == 200 ]] && jq -e '.channel == "SMPP" and .status == "DELIVERED"' <<<"$BODY" >/dev/null
}
wait_for 10 "SMPP CDR visible to R as DELIVERED" smpp_cdr_delivered
ok "SMPP submit $MSG_SMPP → receipt stat:DELIVRD, templated upstream"
C_BAL4=$((C_BAL3 - 5000))

# ============================================================================================
step "9. R stops C's sending, re-enables; suspends C"
# keep an SMPP session bound (receipt for …2222 never comes) to see it get kicked
"$SMPP_CLI" -addr "127.0.0.1:$SMPP_PORT" -system-id "$SMPP_SYS" -password "$SMPP_PW" -from ACME -to "$DEST_KICK" \
  -text "Code 445566 hold" -wait 60s -exit-on-unbind >"$TMP/kick.out" 2>&1 &
KICK_PID=$!
session_count() {
  req GET /api/monitor/smpp-sessions "$R_TOKEN"
  [[ "$CODE" == 200 ]] || return 1
  jq -r --arg s "$SMPP_SYS" '[(.sessions // .items)[] | select(.system_id == $s)] | length' <<<"$BODY"
}
has_session() { [[ "$(session_count)" -ge 1 ]]; }
no_session() { [[ "$(session_count)" == 0 ]]; }
wait_for 15 "SMPP session visible to R" has_session
ok "SMPP session bound (GET /api/monitor/smpp-sessions)"

call PATCH "/api/orgs/$C_ID/channels" "$R_TOKEN" '{"sending_enabled":false}'
req POST /v1/sms/send "key:$C_KEY" "$(jq -nc --arg to "$DEST_OTP" '{to:$to,from:"ACME",text:"Code 111222"}')"
expect_code 422 "send while sending disabled"; expect_jq '.error_code == "SENDING_DISABLED"' "SENDING_DISABLED"
ok "/v1 send → 422 SENDING_DISABLED"
wait_for 15 "live SMPP session kicked" no_session
kick_exited() { ! kill -0 "$KICK_PID" 2>/dev/null; }
wait_for 15 "kicked smpp-cli exits" kick_exited
KICK_PID=""
jq -e '.bound == true and .submit_status == "ESME_ROK" and .unbound == true' "$TMP/kick.out" >/dev/null 2>&1 \
  || fail "kicked smpp-cli output: $(cat "$TMP/kick.out")"
ok "live SMPP session kicked: $(jq -r .error "$TMP/kick.out")"
smpp_send "$DEST_SMPP" "Code 998877 x" -wait 0
jq -e '.bound == false' <<<"$SMPP_OUT" >/dev/null 2>&1 || fail "SMPP bind should be refused while sending is disabled: $SMPP_OUT"
grep -q 'ESME_RINVSYSID' <<<"$SMPP_OUT" || fail "SMPP bind refusal should be ESME_RINVSYSID: $SMPP_OUT"
ok "SMPP bind refused (ESME_RINVSYSID)"

call PATCH "/api/orgs/$C_ID/channels" "$R_TOKEN" '{"sending_enabled":true}'
# No retry: org state changes reach the engine synchronously (CONTRACTS-CHANGES integration #2),
# so the very next request must already be accepted.
req POST /v1/sms/send "key:$C_KEY" "$(jq -nc --arg to "$DEST_OTP" '{to:$to,from:"ACME",text:"Code 246810 again"}')"
expect_code 200 "/v1 send right after re-enable"
MSG_RE="$(jqb '.messages[0].message_id')"
smpp_send "$DEST_SMPP" "Code 135790 back" -wait 20s
jq -e '.ok == true and .dlr.stat == "DELIVRD"' <<<"$SMPP_OUT" >/dev/null 2>&1 || fail "SMPP right after re-enable: $SMPP_OUT"
ok "re-enabled: /v1 send accepted ($MSG_RE), SMPP round trip DELIVRD"

call POST "/api/orgs/$C_ID/suspend" "$R_TOKEN" '{"reason":"e2e suspension"}'
req POST /api/auth/login - "$(jq -nc --arg e "$C_EMAIL" --arg p "$C_PASS" '{email:$e,password:$p}')"
expect_code 403 "suspended client login"; expect_jq '.access_token == null and .error_code == "ACCOUNT_SUSPENDED"' "no token, ACCOUNT_SUSPENDED"
LOGIN_CODE="$CODE"
req POST /v1/sms/send "key:$C_KEY" "$(jq -nc --arg to "$DEST_OTP" '{to:$to,from:"ACME",text:"Code 112233"}')"
expect_code '403|422' "send while suspended"; expect_jq '.error_code == "ACCOUNT_SUSPENDED"' "ACCOUNT_SUSPENDED on /v1"
smpp_send "$DEST_SMPP" "Code 998877 x" -wait 0
jq -e '.bound == false' <<<"$SMPP_OUT" >/dev/null 2>&1 || fail "SMPP bind should be refused while suspended: $SMPP_OUT"
ok "suspended: panel login $LOGIN_CODE ACCOUNT_SUSPENDED, /v1 ACCOUNT_SUSPENDED, SMPP bind refused"
call POST "/api/orgs/$C_ID/activate" "$R_TOKEN"
C_TOKEN="$(login "$C_EMAIL" "$C_PASS")"
ok "re-activated: client logs in again"

# ============================================================================================
step "10. IP whitelist 10.0.0.0/8 only → IP_NOT_ALLOWED"
call DELETE "/api/ip-whitelist/$IPW_ID" "$R_TOKEN"
call POST "/api/ip-whitelist?org_id=$C_ID" "$R_TOKEN" '{"cidr":"10.0.0.0/8","scope":"API","note":"e2e private only"}'
IPW2_ID="$(jqb .id)"
req POST /v1/sms/send "key:$C_KEY" "$(jq -nc --arg to "$DEST_OTP" '{to:$to,from:"ACME",text:"Code 777888"}')"
expect_code 403 "send from 127.0.0.1"; expect_jq '.error_code == "IP_NOT_ALLOWED"' "IP_NOT_ALLOWED"
req GET /v1/balance "key:$C_KEY"; expect_code 403 "balance from 127.0.0.1"
ok "/v1 from 127.0.0.1 → 403 IP_NOT_ALLOWED"
call DELETE "/api/ip-whitelist/$IPW2_ID" "$R_TOKEN"
req GET /v1/balance "key:$C_KEY"; expect_code 200 "no whitelist rows → any IP"
ok "rule removed → allowed again"

# ============================================================================================
step "11. R cannot reach another reseller's client"
R2_EMAIL="$(mail reseller2)" R2_PASS='Reseller2-E2e-Pass1!'
call POST /api/orgs "$ADMIN" "$(jq -nc --arg e "$R2_EMAIL" --arg p "$R2_PASS" '{name:"E2E Reseller 2",email:$e,password:$p}')"
R2_ID="$(jqb .id)"
R2_TOKEN="$(login "$R2_EMAIL" "$R2_PASS")"
call POST /api/orgs "$R2_TOKEN" "$(jq -nc --arg e "$(mail client2)" '{name:"E2E Client 2",email:$e,password:"Client2-E2e-Pass1!"}')"
C2_ID="$(jqb .id)"
req GET "/api/orgs/$C2_ID" "$R_TOKEN";                     expect_code '403|404' "R reads C2"
req PATCH "/api/orgs/$C2_ID/channels" "$R_TOKEN" '{"sending_enabled":false}'; expect_code '403|404' "R changes C2 channels"
req POST "/api/orgs/$C2_ID/suspend" "$R_TOKEN" '{"reason":"x"}'; expect_code '403|404' "R suspends C2"
req POST "/api/orgs/$C2_ID/balance/topup" "$R_TOKEN" '{"amount_micros":1}'; expect_code '403|404' "R tops up C2"
req GET "/api/api-keys?org_id=$C2_ID" "$R_TOKEN";          expect_code '403|404' "R lists C2 API keys"
req POST "/api/api-keys?org_id=$C2_ID" "$R_TOKEN" '{"name":"x"}'; expect_code '403|404' "R creates C2 API key"
req GET "/api/messages?org_id=$C2_ID" "$R_TOKEN";          expect_code '403|404' "R lists C2 messages"
req GET "/api/orgs/$R2_ID" "$R_TOKEN";                     expect_code '403|404' "R reads R2"
req GET /api/orgs "$R_TOKEN"; expect_code 200 "R lists its clients"
expect_jq "$(printf '[.items[].id] | index("%s") != null and index("%s") == null' "$C_ID" "$C2_ID")" "R's org list contains C and not C2"
req GET "/api/orgs/$C_ID" "$R2_TOKEN";                     expect_code '403|404' "R2 reads C"
req GET "/api/messages/$MSG_OTP" "$R2_TOKEN";              expect_code '403|404' "R2 reads C's message"
ok "cross-tenant access refused both ways (R↔R2)"

# ============================================================================================
step "12. reports: messages list, analytics summary, CSV export"
req GET "/api/messages?limit=100" "$R_TOKEN"; expect_code 200 "R message list"
for m in "$MSG_OTP" "$MSG_UNI" "$MSG_FO" "$MSG_SMPP" "$MSG_RE"; do
  jq -e --arg m "$m" '[.items[].id] | index($m) != null' <<<"$BODY" >/dev/null || fail "R's message list misses $m"
done
expect_jq "$(printf '[.items[] | select(.id == "%s")][0] | .client_cost_micros == 5000 and .reseller_cost_micros == 3000 and .route_cost_micros == null' "$MSG_OTP")" "reseller sees client+reseller cost, not route cost"
ok "GET /api/messages as R lists C's messages ($(jqb '.items | length') items)"
req GET "/api/messages?status=DELIVERED&destination=$DEST_OTP" "$C_TOKEN"; expect_code 200 "client filtered list"
expect_jq "$(printf '[.items[].id] | index("%s") != null' "$MSG_OTP")" "client sees its message with filters"

summary_ready() {
  req GET /api/analytics/summary "$R_TOKEN"
  [[ "$CODE" == 200 ]] && jq -e '.messages >= 5 and .delivered >= 4 and .revenue_micros > 0 and .cost_micros > 0' <<<"$BODY" >/dev/null
}
wait_for 20 "analytics summary from rollups" summary_ready
ok "analytics summary (R): $(jq -c '{messages,parts,delivered,failed,delivery_rate,revenue_micros,cost_micros,profit_micros}' <<<"$BODY")"
req GET "/api/analytics/summary?org_id=$C_ID" "$C_TOKEN"; expect_code 200 "client summary"
expect_jq '.messages >= 5 and .cost_micros > 0' "client summary non-zero"
req GET /api/analytics/summary "$ADMIN"; expect_code 200 "admin summary"
expect_jq '.messages >= 5 and .revenue_micros > 0 and .cost_micros > 0' "admin summary non-zero"
req GET "/api/analytics/breakdown?by=route" "$R_TOKEN"; expect_code 200 "breakdown by route"
expect_jq '.rows | length >= 2' "breakdown has both routes"
ok "client/admin summaries and route breakdown non-zero"

CSV_HDR="$TMP/export.hdr"
CODE="$(curl -sS -o "$TMP/export.csv" -D "$CSV_HDR" -w '%{http_code}' --max-time 30 -H "Authorization: Bearer $R_TOKEN" "$API/api/messages/export")"
BODY="$(head -c 600 "$TMP/export.csv")"
expect_code 200 "CSV export"
grep -qi '^content-type: text/csv' "$CSV_HDR" || fail "export content-type is not text/csv"
CSV_ROWS="$(sed '1d' "$TMP/export.csv" | grep -c . || true)"
((CSV_ROWS >= 5)) || fail "CSV export has $CSV_ROWS data rows, want >= 5"
grep -q "$MSG_OTP" "$TMP/export.csv" || fail "CSV export misses $MSG_OTP"
ok "CSV export: $CSV_ROWS rows, header: $(head -1 "$TMP/export.csv" | tr -d '\r\357\273\277' | cut -c1-120)…"

# ============================================================================================
step "13. web panel"
if [[ "$SKIP_WEB" == 1 ]]; then
  ok "skipped (E2E_SKIP_WEB=1)"
else
  for p in /login /dashboard /resellers /clients /connections /routes /templates /messages /analytics /monitor \
           /tester /send /campaigns /developer /sender-ids /blocklist /settings; do
    code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 30 "$WEB$p")"
    [[ "$code" == 200 ]] || { CODE="$code" BODY=""; fail "web $p → HTTP $code"; }
  done
  ok "web pages answer 200"
  req POST "$WEB/api/auth/login" - "$(jq -nc --arg e "$R_EMAIL" --arg p "$R_PASS" '{email:$e,password:$p}')"
  expect_code 200 "login through the web proxy"; expect_jq '.access_token | length > 20' "token via web proxy"
  req GET "$WEB/api/messages?limit=5" "$(jqb .access_token)"; expect_code 200 "messages through the web proxy"
  ok "web proxies /api to the api (login + messages)"
fi

printf '\n\033[1;32mE2E PASSED\033[0m (%d checks)\n' "$PASSED" >&2
