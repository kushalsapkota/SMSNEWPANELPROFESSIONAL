import { describe, expect, it } from "vitest";
import { analyzeSms, canBecomeGsm, gsmSeptets, isGsm7, MAX_PARTS, partCount, toGsmSafe, visibleChar } from "@/lib/sms";

describe("GSM 03.38 alphabet", () => {
  it("accepts the whole basic table as 1 septet", () => {
    const basic =
      "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?" +
      "¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
    for (const ch of Array.from(basic)) expect(gsmSeptets(ch), ch).toBe(1);
    expect(analyzeSms(basic)).toMatchObject({ encoding: "GSM7", units: Array.from(basic).length });
  });

  it("counts every extension character as 2 septets", () => {
    for (const ch of Array.from("^{}\\[~]|€\f")) expect(gsmSeptets(ch), ch).toBe(2);
    expect(analyzeSms("a{b}")).toMatchObject({ encoding: "GSM7", units: 6, extChars: 2, chars: 4 });
  });

  it("rejects the raw ESC control character and common non-GSM chars (engine parity)", () => {
    expect(isGsm7("\u001b")).toBe(false);
    for (const ch of ["`", "á", "ç", "ê", "\t", "’", "–", "€"]) {
      if (ch === "€") expect(isGsm7(ch)).toBe(true);
      else expect(isGsm7(ch), ch).toBe(false);
    }
  });
});

describe("parts (CONTRACTS §3)", () => {
  it("GSM-7 single up to 160, then 153 per part", () => {
    expect(analyzeSms("a".repeat(160))).toMatchObject({ encoding: "GSM7", parts: 1, perPart: 160, remaining: 0 });
    expect(analyzeSms("a".repeat(161))).toMatchObject({ parts: 2, perPart: 153, remaining: 145 });
    expect(analyzeSms("a".repeat(306))).toMatchObject({ parts: 2, remaining: 0 });
    expect(analyzeSms("a".repeat(307))).toMatchObject({ parts: 3 });
  });

  it("is septet-aware: extension chars push into the next part", () => {
    expect(analyzeSms("€".repeat(80))).toMatchObject({ units: 160, parts: 1 });
    expect(analyzeSms("€".repeat(81))).toMatchObject({ units: 162, parts: 2 });
    expect(analyzeSms("a".repeat(159) + "[")).toMatchObject({ units: 161, parts: 2 });
  });

  it("UCS-2 single up to 70 code units, then 67 per part", () => {
    expect(analyzeSms("ж".repeat(70))).toMatchObject({ encoding: "UCS2", parts: 1, perPart: 70 });
    expect(analyzeSms("ж".repeat(71))).toMatchObject({ parts: 2, perPart: 67, remaining: 63 });
    expect(analyzeSms("ж".repeat(134))).toMatchObject({ parts: 2 });
    expect(analyzeSms("ж".repeat(135))).toMatchObject({ parts: 3 });
  });

  it("one non-GSM char switches the whole message to UCS-2 and counts all chars", () => {
    const a = analyzeSms("é".repeat(10) + "ж");
    expect(a).toMatchObject({ encoding: "UCS2", units: 11, parts: 1, extChars: 0 });
    expect(a.nonGsm).toEqual(["ж"]);
    // extension chars cost 1 unit in UCS-2
    expect(analyzeSms("€ж")).toMatchObject({ encoding: "UCS2", units: 2 });
  });

  it("counts UTF-16 code units (astral emoji = 2)", () => {
    expect(analyzeSms("😀".repeat(35))).toMatchObject({ units: 70, parts: 1, chars: 35 });
    expect(analyzeSms("😀".repeat(36))).toMatchObject({ units: 72, parts: 2 });
  });

  it("flags more than 10 parts as too long", () => {
    expect(analyzeSms("a".repeat(153 * MAX_PARTS)).tooLong).toBe(false);
    expect(analyzeSms("a".repeat(153 * MAX_PARTS + 1)).tooLong).toBe(true);
    expect(analyzeSms("ж".repeat(67 * MAX_PARTS)).tooLong).toBe(false);
    expect(analyzeSms("ж".repeat(67 * MAX_PARTS + 1)).tooLong).toBe(true);
  });

  it("empty text has no parts", () => {
    expect(analyzeSms("")).toMatchObject({ encoding: "GSM7", units: 0, parts: 0, remaining: 160 });
    expect(partCount(0, "UCS2")).toBe(0);
  });
});

describe("GSM-safe helpers", () => {
  it("replaces smart punctuation", () => {
    const s = "It’s “fine” – really…";
    expect(isGsm7(s)).toBe(false);
    expect(canBecomeGsm(s)).toBe(true);
    expect(toGsmSafe(s)).toBe('It\'s "fine" - really...');
    expect(canBecomeGsm("Привет")).toBe(false);
  });

  it("makes invisible chars visible", () => {
    expect(visibleChar(" ")).toBe("U+00A0");
    expect(visibleChar("ж")).toBe("ж");
  });
});
