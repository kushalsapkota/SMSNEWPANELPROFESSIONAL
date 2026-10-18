-- =============================================================================
-- 005_otp_patterns.sql — better default OTP extraction patterns
--
-- The 001 defaults ('\b[0-9]{4,8}\b' first) return the FIRST 4-8 digit run,
-- so "Pay Rs 2500 ... OTP 772211" extracted 2500. These defaults are ordered
-- most-specific first; patterns with a capture group yield group 1 as the OTP
-- (the Go engine uses the first non-empty capturing group, else the whole
-- match, and checks every match of each pattern against otp_min_len /
-- otp_max_len). All patterns are RE2-compatible.
--
--   1. keyword immediately followed by code     "OTP is 4821", "Code: 5521"
--   2. code then "is your/the ... keyword"      "849201 is your code"
--   3. keyword ... is/: code (skips dates/amts) "OTP for login on 2024-05-01 is 5521"
--   4. keyword, a few words, then code          "Code for Acme 5521"
--   5. any standalone 4-8 digit number          "use 1234 to login"
--   6. mixed alnum (>=1 letter and >=1 digit)   "AB12CD"
--
-- Mirrored by engine/internal/otp.DefaultPatterns (a Go test asserts equality).
-- Only the column DEFAULT changes; existing templates keep their patterns.
-- =============================================================================

BEGIN;

ALTER TABLE route_templates
  ALTER COLUMN extract_patterns SET DEFAULT ARRAY[
    '(?i)\b(?:otp|code|pin|passcode|password|passwd|token)\b(?:\s*(?:is|:|=|-|#))*\s*([0-9]{4,8})\b',
    '(?i)\b([0-9]{4,8})\b\s*(?:is|=|:|-)?\s*(?:your|the|ur)\b[^0-9\n]{0,40}?\b(?:otp|code|pin|passcode|password|token)\b',
    '(?i)\b(?:otp|code|pin|passcode|password|passwd|token)\b.{0,60}?(?:\bis\b|:)\s*:?\s*([0-9]{4,8})\b',
    '(?i)\b(?:otp|code|pin|passcode|password|passwd|token)\b[^0-9\n]{0,20}?\b([0-9]{4,8})\b',
    '\b[0-9]{4,8}\b',
    '\b[A-Za-z0-9]*(?:[A-Za-z][0-9]|[0-9][A-Za-z])[A-Za-z0-9]*\b'
  ]::text[];

COMMIT;
