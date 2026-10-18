import { describe, expect, it } from "vitest";
import { checkCidr } from "@/lib/cidr";
import { normalizeMsisdn, parseRecipients, isValidSender } from "@/lib/phone";
import { longestPrefixMatch } from "@/lib/rates";
import { analyzeSms } from "@/lib/sms";
import { re2Error } from "@/lib/validation";

describe("checkCidr", () => {
  it.each([
    ["10.0.0.0/8", "10.0.0.0/8"],
    ["203.0.113.7", "203.0.113.7/32"],
    ["2001:db8::/32", "2001:db8::/32"],
    ["::1", "::1/128"],
    ["0.0.0.0/0", "0.0.0.0/0"],
  ])("accepts %s", (input, normalized) => {
    expect(checkCidr(input)).toEqual({ ok: true, normalized });
  });
  it.each(["10.0.0.1/8", "256.1.1.1", "1.2.3", "1.2.3.4/33", "2001:db8::1/32", "foo", "1.2.3.4/8/1"])(
    "rejects %s",
    (input) => {
      expect(checkCidr(input).ok).toBe(false);
    },
  );
});

describe("MSISDN (CONTRACTS §3)", () => {
  it("strips +, spaces and dashes", () => {
    expect(normalizeMsisdn("+91 98765-43210")).toBe("919876543210");
  });
  it("rejects too short / long / non-digit", () => {
    expect(normalizeMsisdn("12345")).toBeNull();
    expect(normalizeMsisdn("1234567890123456")).toBeNull();
    expect(normalizeMsisdn("91abc")).toBeNull();
  });
  it("parses recipient lists with dedupe", () => {
    expect(parseRecipients("+919876543210\n919876543210, bad;447700900123")).toEqual({
      valid: ["919876543210", "447700900123"],
      invalid: ["bad"],
    });
  });
  it("validates senders like the DB check", () => {
    expect(isValidSender("MYBANK")).toBe(true);
    expect(isValidSender("+919876543210")).toBe(true);
    expect(isValidSender("TOOLONGSENDER")).toBe(false);
  });
});

describe("analyzeSms (CONTRACTS §3)", () => {
  it("GSM-7 single and multipart", () => {
    expect(analyzeSms("a".repeat(160))).toMatchObject({ encoding: "GSM7", parts: 1 });
    expect(analyzeSms("a".repeat(161))).toMatchObject({ encoding: "GSM7", parts: 2 });
    expect(analyzeSms("a".repeat(306))).toMatchObject({ parts: 2 });
    expect(analyzeSms("a".repeat(307))).toMatchObject({ parts: 3 });
  });
  it("extension chars count as 2 septets", () => {
    expect(analyzeSms("€".repeat(80))).toMatchObject({ encoding: "GSM7", units: 160, parts: 1 });
    expect(analyzeSms("€".repeat(81))).toMatchObject({ parts: 2 });
  });
  it("UCS-2 counts UTF-16 units", () => {
    expect(analyzeSms("é".repeat(10) + "ж")).toMatchObject({ encoding: "UCS2", units: 11, parts: 1 });
    expect(analyzeSms("ж".repeat(71))).toMatchObject({ encoding: "UCS2", parts: 2 });
    expect(analyzeSms("😀".repeat(35))).toMatchObject({ units: 70, parts: 1 });
  });
  it("flags > 10 parts", () => {
    expect(analyzeSms("a".repeat(153 * 10 + 1)).tooLong).toBe(true);
  });
});

describe("longestPrefixMatch", () => {
  const rates = [
    { prefix: "", cost: 1 },
    { prefix: "91", cost: 2 },
    { prefix: "9198", cost: 3 },
  ];
  it("picks the longest matching prefix", () => {
    expect(longestPrefixMatch(rates, "919876543210")?.cost).toBe(3);
    expect(longestPrefixMatch(rates, "917000000000")?.cost).toBe(2);
    expect(longestPrefixMatch(rates, "447700900123")?.cost).toBe(1);
    expect(longestPrefixMatch(rates.slice(1), "447700900123")).toBeNull();
  });
});

describe("re2Error", () => {
  it("accepts the default OTP patterns", () => {
    expect(re2Error("\\b[0-9]{4,8}\\b")).toBeNull();
    expect(re2Error("\\b[A-Za-z0-9]*(?:[A-Za-z][0-9]|[0-9][A-Za-z])[A-Za-z0-9]*\\b")).toBeNull();
  });
  it("rejects look-arounds, backreferences and invalid syntax", () => {
    expect(re2Error("(?=\\d)")).toMatch(/Look-arounds/);
    expect(re2Error("(?<!x)y")).toMatch(/Look-arounds/);
    expect(re2Error("(a)\\1")).toMatch(/Backreferences/);
    expect(re2Error("([")).not.toBeNull();
  });
});
