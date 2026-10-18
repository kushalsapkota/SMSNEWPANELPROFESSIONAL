--[[
credit.lua — apply a top-up / manual adjustment to a loaded balance.

The Postgres ledger row (balance_transactions) is written first; its
idempotency_key is passed here so a retry never applies twice. If the balance
isn't loaded, nothing happens — hydration from Postgres will include it.

KEYS[1]  balance hash       {t:<reseller_id>}:bal:<org_id>
KEYS[2]  idempotency key    {t:<reseller_id>}:credit:<ledger idempotency_key>
ARGV[1]  signed delta in micros (e.g. "5000000" or "-250000")
ARGV[2]  idempotency ttl seconds

Returns:
  {1, "OK", new_bal}
  {1, "DUPLICATE", bal}
  {0, "NOT_LOADED"}
  {0, "BAD_ARGS", reason}
]]

if not string.match(ARGV[1] or '', '^-?%d+$') then
  return {0, 'BAD_ARGS', 'delta must be an integer'}
end
local ttl = tonumber(ARGV[2])
if not ttl or ttl <= 0 then
  return {0, 'BAD_ARGS', 'ttl must be positive'}
end

if redis.call('EXISTS', KEYS[1]) == 0 then
  return {0, 'NOT_LOADED'}
end

if redis.call('SET', KEYS[2], '1', 'NX', 'EX', ttl) == false then
  return {1, 'DUPLICATE', redis.call('HGET', KEYS[1], 'bal')}
end

local delta = string.format('%d', tonumber(ARGV[1]))
return {1, 'OK', tostring(redis.call('HINCRBY', KEYS[1], 'bal', delta))}
