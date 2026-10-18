--[[
debit.lua — atomic multi-tier pre-submission debit.

Debits every balance in one atomic step (client at its rate, reseller at its
rate) or none of them. Idempotent per transaction id, so a retried submit
never double-charges.

KEYS[1]       txn key           {t:<reseller_id>}:txn:<message_id>
KEYS[2..n+1]  balance hashes    {t:<reseller_id>}:bal:<org_id>
ARGV[1]       txn ttl seconds   (window in which refund.lua can still refund)
ARGV[2..n+1]  amounts in micros, non-negative integers, aligned with KEYS[2..]

All keys share the {t:<reseller_id>} hash tag so they live in one Redis
Cluster slot (a client and its reseller are always in the same tenant tree).

Balance hash fields:
  bal    integer micros (may go negative down to -limit)
  limit  overdraft in micros, >= 0 (0 for prepaid)

Returns:
  {1, "OK",        bal_1, ..., bal_n}   new balances (strings)
  {1, "DUPLICATE", bal_1, ..., bal_n}   txn already debited, nothing changed
  {0, "NOT_LOADED", i}                  hash i missing: hydrate from Postgres, retry
  {0, "INSUFFICIENT_FUNDS", i}          balance i would drop below -limit
  {0, "BAD_ARGS", reason}
]]

local n = #KEYS - 1
if n < 1 or #ARGV ~= n + 1 then
  return {0, 'BAD_ARGS', 'expected 1 txn key + n balance keys and ttl + n amounts'}
end

local ttl = tonumber(ARGV[1])
if not ttl or ttl <= 0 or ttl ~= math.floor(ttl) then
  return {0, 'BAD_ARGS', 'ttl must be a positive integer'}
end

local txn_key = KEYS[1]

if redis.call('EXISTS', txn_key) == 1 then
  local res = {1, 'DUPLICATE'}
  for i = 1, n do
    res[#res + 1] = redis.call('HGET', KEYS[i + 1], 'bal') or ''
  end
  return res
end

-- Validate everything before mutating anything.
for i = 1, n do
  local amount = ARGV[i + 1]
  if not string.match(amount, '^%d+$') then
    return {0, 'BAD_ARGS', 'amount ' .. i .. ' must be a non-negative integer'}
  end

  local h = redis.call('HMGET', KEYS[i + 1], 'bal', 'limit')
  if not h[1] then
    return {0, 'NOT_LOADED', i}
  end

  local bal   = tonumber(h[1])
  local limit = tonumber(h[2] or '0') or 0
  if bal - tonumber(amount) < -limit then
    return {0, 'INSUFFICIENT_FUNDS', i}
  end
end

local res = {1, 'OK'}
local txn = {'n', n, 'state', 'DEBITED'}

for i = 1, n do
  -- Re-format so "007" / "0" become valid HINCRBY integers ("-0" is not).
  local amount = string.format('%d', tonumber(ARGV[i + 1]))
  res[#res + 1] = tostring(redis.call('HINCRBY', KEYS[i + 1], 'bal', string.format('%d', -tonumber(amount))))

  txn[#txn + 1] = 'k' .. i; txn[#txn + 1] = KEYS[i + 1]
  txn[#txn + 1] = 'a' .. i; txn[#txn + 1] = amount
  txn[#txn + 1] = 'r' .. i; txn[#txn + 1] = 0
end

redis.call('HSET', txn_key, unpack(txn))
redis.call('EXPIRE', txn_key, ttl)

return res
