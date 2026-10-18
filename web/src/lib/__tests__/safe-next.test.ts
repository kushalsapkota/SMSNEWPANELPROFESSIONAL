import { describe, expect, it } from "vitest";
import { safeNext } from "@/lib/safe-next";

describe("safeNext", () => {
  it.each([
    ["/dashboard", "/dashboard"],
    ["/clients/abc?tab=rates#x", "/clients/abc?tab=rates#x"],
    ["/messages?q=a%2Fb", "/messages?q=a%2Fb"],
    ["/reports/../billing", "/billing"],
  ])("allows same-site path %s", (input, expected) => {
    expect(safeNext(input)).toBe(expected);
  });

  it.each([
    null,
    undefined,
    "",
    "dashboard",
    "https://evil.com",
    "//evil.com",
    "/\\evil.com",
    "/\\/evil.com",
    "\\\\evil.com",
    "/\t/evil.com",
    "/\n/evil.com",
    "/\r//evil.com",
    "/%09/evil.com/\u0000",
    "/login",
    "/login?next=/x",
    "/login/",
    "/.//evil.com",
    "/a/..//evil.com",
  ])("rejects %j", (input) => {
    expect(safeNext(input)).toBe("/dashboard");
  });

  it("never yields a foreign origin when resolved like the browser does", () => {
    const origin = "https://panel.example.com";
    for (const raw of ["/\\evil.com", "/\t/evil.com", "/ /evil.com", "/%5Cevil.com", "/.//evil.com"]) {
      expect(new URL(safeNext(raw), origin).origin).toBe(origin);
    }
  });

  it("uses the supplied fallback", () => {
    expect(safeNext("//evil.com", "/home")).toBe("/home");
  });
});
