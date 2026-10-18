import { describe, expect, it } from "vitest";
import { detectDelimiter, findPhoneColumn, parseCsv, parseCsvRecords, rowsToObjects, toCsv } from "@/lib/csv";
import { findPlaceholders, insertAt, missingPlaceholders, normalizeColumn, renderTemplate } from "@/lib/template-vars";
import { parseRecipients } from "@/lib/phone";

describe("csv", () => {
  it("parses quotes, doubled quotes, CRLF and BOM", () => {
    const text = '﻿phone,name,note\r\n919876543210,"Doe, Jane","said ""hi"""\r\n\r\n14155550100,Bob,\n';
    const csv = parseCsv(text);
    expect(csv.headers).toEqual(["phone", "name", "note"]);
    expect(csv.rows).toEqual([
      ["919876543210", "Doe, Jane", 'said "hi"'],
      ["14155550100", "Bob", ""],
    ]);
    expect(csv.ragged).toBe(0);
  });

  it("keeps newlines inside quoted fields", () => {
    expect(parseCsvRecords('a,b\n"x\ny",z')).toEqual([
      ["a", "b"],
      ["x\ny", "z"],
    ]);
  });

  it("detects ; and tab delimiters", () => {
    expect(detectDelimiter("phone;name\n1;2")).toBe(";");
    expect(detectDelimiter("phone\tname")).toBe("\t");
    expect(detectDelimiter('"a;b",c,d')).toBe(",");
    expect(parseCsv("phone;name\n91;Ann").rows).toEqual([["91", "Ann"]]);
  });

  it("counts ragged rows and maps objects", () => {
    const csv = parseCsv("phone,name\n1,a,extra\n2");
    expect(csv.ragged).toBe(2);
    expect(rowsToObjects(csv)).toEqual([
      { phone: "1", name: "a" },
      { phone: "2", name: "" },
    ]);
  });

  it("finds the phone column", () => {
    expect(findPhoneColumn(["Name", "Phone"])).toBe("Phone");
    expect(findPhoneColumn(["msisdn"])).toBe("msisdn");
    expect(findPhoneColumn(["a", "b"])).toBeNull();
  });

  it("round-trips through toCsv", () => {
    const out = toCsv(["phone", "name"], [["1", 'A "q", b']]);
    expect(parseCsv(out).rows).toEqual([["1", 'A "q", b']]);
  });
});

describe("template vars (api parity)", () => {
  it("normalizes headers like the api", () => {
    expect(normalizeColumn(" First Name ")).toBe("first_name");
    expect(normalizeColumn("Amount (INR)")).toBe("amount_inr");
    expect(normalizeColumn("__x__")).toBe("x");
  });

  it("finds distinct lower-cased placeholders, only [A-Za-z0-9_] names", () => {
    expect(findPlaceholders("Hi {name}, code {Code}. Bye {NAME} {first name} {}")).toEqual(["name", "code"]);
  });

  it("renders case-insensitively and leaves unknown placeholders", () => {
    expect(renderTemplate("Hi {name} {Name} {CITY} {zip}", { name: "Ann", city: "Pune" })).toBe("Hi Ann Ann Pune {zip}");
  });

  it("reports missing columns", () => {
    expect(missingPlaceholders("{name} {amount}", ["name"])).toEqual(["amount"]);
  });

  it("inserts at the selection", () => {
    expect(insertAt("Hello !", "{name}", 6, 6)).toEqual({ text: "Hello {name}!", caret: 12 });
    expect(insertAt("abc", "X", 1, 2)).toEqual({ text: "aXc", caret: 2 });
    expect(insertAt("abc", "X", null, null)).toEqual({ text: "abcX", caret: 4 });
  });
});

describe("recipients", () => {
  it("dedupes after normalization and splits on newline/comma/semicolon/space-less", () => {
    const r = parseRecipients("+91 98765 43210\n919876543210, 14155550100;abc\n12");
    expect(r.valid).toEqual(["919876543210", "14155550100"]);
    expect(r.invalid).toEqual(["abc", "12"]);
  });
});
