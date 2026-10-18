#!/usr/bin/env bash
# Tests the balance Lua scripts against a scratch Redis.
#   REDIS_PORT=6399 redis/tests/lua_test.sh
# WARNING: flushes the target DB (default db 15).
set -euo pipefail

LUA="$(cd "$(dirname "$0")/../lua" && pwd)"
R=(redis-cli -p "${REDIS_PORT:-6379}" -n "${REDIS_DB:-15}")
"${R[@]}" FLUSHDB >/dev/null

T='{t:r1}'
CLIENT="$T:bal:c1"
RESELLER="$T:bal:r1"
fail=0

ev() {  # ev <script> <keys...> , <args...>  -> reply joined by spaces
  "${R[@]}" --eval "$LUA/$1.lua" "${@:2}" | tr '\n' ' ' | sed 's/ $//'
}
check() {  # check <label> <expected> <actual>
  if [[ "$2" == "$3" ]]; then echo "ok - $1"; else echo "FAIL - $1: expected [$2] got [$3]"; fail=1; fi
}

check "debit before hydrate" "0 NOT_LOADED 1" "$(ev debit $T:txn:m0 $CLIENT $RESELLER , 3600 100 50)"

check "load client"      "1 OK 1000"            "$(ev load $CLIENT , 1000 0)"
check "load reseller"    "1 OK 500"             "$(ev load $RESELLER , 500 0)"
check "load is no-clobber" "1 ALREADY_LOADED 1000" "$(ev load $CLIENT , 999999 0)"
check "load rejects junk" "0 BAD_ARGS balance must be an integer, limit a non-negative integer" "$(ev load $T:bal:x , 1.5 0)"

check "debit both tiers"  "1 OK 900 450"        "$(ev debit $T:txn:m1 $CLIENT $RESELLER , 3600 100 50)"
check "duplicate is no-op" "1 DUPLICATE 900 450" "$(ev debit $T:txn:m1 $CLIENT $RESELLER , 3600 100 50)"
check "zero-cost tier ok" "1 OK 890 450"        "$(ev debit $T:txn:m2 $CLIENT $RESELLER , 3600 10 0)"
check "leading zeros ok"  "1 OK 883 443"        "$(ev debit $T:txn:m3 $CLIENT $RESELLER , 3600 007 007)"

check "reseller short = nothing debited" "0 INSUFFICIENT_FUNDS 2" "$(ev debit $T:txn:m4 $CLIENT $RESELLER , 3600 10 444)"
check "client untouched after failed debit" "883" "$("${R[@]}" HGET $CLIENT bal)"
check "failed debit leaves no txn" "0" "$("${R[@]}" EXISTS $T:txn:m4)"

check "negative amount rejected" "0 BAD_ARGS amount 1 must be a non-negative integer" "$(ev debit $T:txn:m5 $CLIENT , 3600 -5)"
check "float amount rejected"    "0 BAD_ARGS amount 1 must be a non-negative integer" "$(ev debit $T:txn:m5 $CLIENT , 3600 1.5)"
check "arity checked"            "0 BAD_ARGS expected 1 txn key + n balance keys and ttl + n amounts" "$(ev debit $T:txn:m5 $CLIENT $RESELLER , 3600 1)"
check "txn ttl set" "1" "$(( $("${R[@]}" TTL $T:txn:m1) > 3500 ))"

# Postpaid overdraft
ev load $T:bal:c2 , 0 300 >/dev/null
check "postpaid may go to -limit" "1 OK -300" "$(ev debit $T:txn:p1 $T:bal:c2 , 60 300)"
check "but not past it"           "0 INSUFFICIENT_FUNDS 1" "$(ev debit $T:txn:p2 $T:bal:c2 , 60 1)"

# Refunds
check "partial refund"            "1 OK 40 20"     "$(ev refund $T:txn:m1 $CLIENT $RESELLER , 40 20)"
check "refund capped at remaining" "1 OK 60 30"    "$(ev refund $T:txn:m1 $CLIENT $RESELLER , 1000 1000)"
check "balances restored"         "983 493"        "$("${R[@]}" HGET $CLIENT bal) $("${R[@]}" HGET $RESELLER bal)"
check "no double refund"          "1 NOTHING_TO_REFUND" "$(ev refund $T:txn:m1 $CLIENT $RESELLER)"
check "state REFUNDED"            "REFUNDED"       "$("${R[@]}" HGET $T:txn:m1 state)"
check "full refund (no args)"     "1 OK 10 0"      "$(ev refund $T:txn:m2 $CLIENT $RESELLER)"
check "refund wrong key order"    "0 KEY_MISMATCH 1" "$(ev refund $T:txn:m3 $RESELLER $CLIENT)"
check "refund unknown txn"        "0 NO_TXN"       "$(ev refund $T:txn:nope $CLIENT)"
"${R[@]}" DEL $RESELLER >/dev/null
check "refund into evicted balance refused" "0 NOT_LOADED 2" "$(ev refund $T:txn:m3 $CLIENT $RESELLER)"
check "...and changed nothing"    "993" "$("${R[@]}" HGET $CLIENT bal)"

# Credits
check "credit not loaded"   "0 NOT_LOADED"     "$(ev credit $T:bal:ghost $T:credit:k0 , 100 60)"
check "credit"              "1 OK 1993"        "$(ev credit $CLIENT $T:credit:k1 , 1000 86400)"
check "credit idempotent"   "1 DUPLICATE 1993" "$(ev credit $CLIENT $T:credit:k1 , 1000 86400)"
check "negative adjustment" "1 OK 1893"        "$(ev credit $CLIENT $T:credit:k2 , -100 86400)"
check "credit rejects -0 junk" "0 BAD_ARGS delta must be an integer" "$(ev credit $CLIENT $T:credit:k3 , 1e3 60)"

# Concurrency: 1000 parallel debits of 7 against a balance of 3500 -> exactly 500 succeed.
ev load $T:bal:race , 3500 0 >/dev/null
SHA=$("${R[@]}" SCRIPT LOAD "$(cat "$LUA/debit.lua")")
seq 1 1000 | xargs -P 64 -I{} "${R[@]}" EVALSHA "$SHA" 2 $T:txn:race{} $T:bal:race 60 7 \
  | grep -c '^OK$' > /tmp/.race_ok.$$ || true
check "race: exactly 500 debits succeed" "500" "$(cat /tmp/.race_ok.$$)"
check "race: balance is exactly 0"       "0"   "$("${R[@]}" HGET $T:bal:race bal)"
rm -f /tmp/.race_ok.$$

"${R[@]}" FLUSHDB >/dev/null
[[ $fail == 0 ]] && echo "ALL LUA TESTS PASSED" || { echo "SOME LUA TESTS FAILED"; exit 1; }
