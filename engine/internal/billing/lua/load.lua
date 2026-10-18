--[[
load.lua — hydrate a balance from Postgres (accounts_balance) into Redis.

Only loads when the key is absent, so a slow hydrator can never overwrite a
live balance that has already taken debits.

KEYS[1]  balance hash   {t:<reseller_id>}:bal:<org_id>
ARGV[1]  balance micros (signed integer)
ARGV[2]  credit limit micros (>= 0)

Returns:
  {1, "OK", bal}
  {1, "ALREADY_LOADED", current_bal}
  {0, "BAD_ARGS", reason}
]]

if not string.match(ARGV[1] or '', '^-?%d+$') or not string.match(ARGV[2] or '', '^%d+$') then
  return {0, 'BAD_ARGS', 'balance must be an integer, limit a non-negative integer'}
end

if redis.call('EXISTS', KEYS[1]) == 1 then
  return {1, 'ALREADY_LOADED', redis.call('HGET', KEYS[1], 'bal')}
end

local bal = string.format('%d', tonumber(ARGV[1]))
redis.call('HSET', KEYS[1], 'bal', bal, 'limit', string.format('%d', tonumber(ARGV[2])))
return {1, 'OK', bal}
