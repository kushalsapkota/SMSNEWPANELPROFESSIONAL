import { describe, expect, it } from "vitest";
import { formatMoney, margin, microsToDecimalString, parseMoneyToMicros } from "@/lib/money";

describe("parseMoneyToMicros", () => {
  it.each([
    ["1", 1_000_000],
    ["0.005", 5_000],
    ["12.34", 12_340_000],
    ["-0.0045", -4_500],
    ["1,234.5", 1_234_500_000],
    [".5", 500_000],
    ["0.000001", 1],
  ])("%s → %d", (input, micros) => {
    expect(parseMoneyToMicros(input)).toBe(micros);
  });

  it("is exact where floats are not (0.1 + 0.2)", () => {
    expect(parseMoneyToMicros("0.3")).toBe(300_000);
  });

  it.each(["", "abc", "1.2.3", "0.0000001", "-", "."])("rejects %j", (input) => {
    expect(parseMoneyToMicros(input)).toBeNull();
  });
});

describe("microsToDecimalString", () => {
  it("round-trips", () => {
    for (const m of [0, 1, 5_000, 12_340_000, -4_500, 999_999_999]) {
      expect(parseMoneyToMicros(microsToDecimalString(m))).toBe(m);
    }
  });
  it("trims trailing zeros", () => {
    expect(microsToDecimalString(12_340_000)).toBe("12.34");
    expect(microsToDecimalString(-4_500)).toBe("-0.0045");
  });
});

describe("formatMoney", () => {
  it("shows up to 4 decimals", () => {
    expect(formatMoney(5_000, "USD")).toBe("$0.005");
    expect(formatMoney(12_340_000, "USD")).toBe("$12.34");
    expect(formatMoney(1_234, "USD")).toBe("$0.0012");
    expect(formatMoney(1_000_000_000, "USD")).toBe("$1,000.00");
  });
  it("handles nulls and negatives", () => {
    expect(formatMoney(null)).toBe("—");
    expect(formatMoney(-2_500_000, "USD")).toBe("-$2.50");
  });
  it("supports 2-decimal display", () => {
    expect(formatMoney(12_345_678, "USD", 2)).toBe("$12.35");
  });
});

describe("margin", () => {
  it("computes diff and percent over cost", () => {
    expect(margin(6_000, 4_000)).toEqual({ diff: 2_000, pct: 50 });
    expect(margin(3_000, 4_000)?.diff).toBe(-1_000);
    expect(margin(1, null)).toBeNull();
  });
});
