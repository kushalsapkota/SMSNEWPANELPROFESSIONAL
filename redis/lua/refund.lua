--[[
refund.lua — refund a debit made by debit.lua (fully or partially).

Used when a message is rejected/fails before or at submission, or when only
some parts of a multipart message were accepted upstream. Refunds are capped
at what was debited and can never be applied twice.

KEYS[1]       txn key (same as the debit)
KEYS[2..n+1]  balance hashes, same order as the debit
ARGV          empty            -> refund everything not yet refunded
              n amounts (micros) -> refund up to these per balance

Returns:
  {1, "OK", refunded_1, ..., refunded_n}   amounts actually refunded now
  {1, "NOTHING_TO_REFUND"}                 already fully refunded
  {0, "NO_TXN"}                            txn unknown or expired
  {0, "KEY_MISMATCH", i}                   KEYS[i+1] isn't the debited key
  {0, "NOT_LOADED", i}                     balance hash i missing (evicted / flushed):
                                           record the refund in the Postgres ledger instead
  {0, "BAD_ARGS", reason}
]]

local txn_key = KEYS[1]
local n = tonumber(redis.call('HGET', txn_key, 'n'))
if not n then
  return {0, 'NO_TXN'}
end

if #KEYS - 1 ~= n then
  return {0, 'BAD_ARGS', 'expected ' .. n .. ' balance keys'}
end
if #ARGV ~= 0 and #ARGV ~= n then
  return {0, 'BAD_ARGS', 'pass no amounts or exactly ' .. n}
end

local refund = {}
local total = 0

for i = 1, n do
  if redis.call('HGET', txn_key, 'k' .. i) ~= KEYS[i + 1] then
    return {0, 'KEY_MISMATCH', i}
  end
  if redis.call('EXISTS', KEYS[i + 1]) == 0 then
    return {0, 'NOT_LOADED', i}
  end

  local debited   = tonumber(redis.call('HGET', txn_key, 'a' .. i))
  local refunded  = tonumber(redis.call('HGET', txn_key, 'r' .. i))
  local remaining = debited - refunded

  local want = remaining
  if #ARGV == n then
    if not string.match(ARGV[i], '^%d+$') then
      return {0, 'BAD_ARGS', 'amount ' .. i .. ' must be a non-negative integer'}
    end
    want = math.min(tonumber(ARGV[i]), remaining)
  end

  refund[i] = want
  total = total + want
end

if total == 0 then
  return {1, 'NOTHING_TO_REFUND'}
end

local res = {1, 'OK'}
local fully = true

for i = 1, n do
  local amt = refund[i]
  if amt > 0 then
    redis.call('HINCRBY', KEYS[i + 1], 'bal', string.format('%d', amt))
    redis.call('HINCRBY', txn_key, 'r' .. i, string.format('%d', amt))
  end
  if tonumber(redis.call('HGET', txn_key, 'r' .. i)) < tonumber(redis.call('HGET', txn_key, 'a' .. i)) then
    fully = false
  end
  res[#res + 1] = string.format('%d', amt)
end

redis.call('HSET', txn_key, 'state', fully and 'REFUNDED' or 'PARTIALLY_REFUNDED')

return res
