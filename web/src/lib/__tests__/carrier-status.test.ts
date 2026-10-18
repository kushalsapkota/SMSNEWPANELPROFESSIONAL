import { describe, expect, it } from "vitest";
import { connectionStateView, describeConnectionError } from "@/lib/carrier-status";

const ep = { host: "10.0.0.5", port: 2775 };

describe("describeConnectionError", () => {
  it("returns null without an error", () => {
    expect(describeConnectionError(null)).toBeNull();
    expect(describeConnectionError("")).toBeNull();
  });
  it.each([
    ["smpp client: bind rejected: ESME_RINVPASWD", "Wrong username or password"],
    ["smpp client: bind rejected: ESME_RINVSYSID", "Wrong username or password"],
    ["smpp client: bind rejected: ESME_RINVSYSTYP", "Wrong system type. Ask the carrier for the right value (often empty)"],
    ["smpp client: bind rejected: 0x00000400", "The carrier rejected the login (0x00000400)"],
  ])("maps bind error %s", (raw, words) => {
    expect(describeConnectionError(raw, ep)).toBe(words);
  });
  it("mentions the IP whitelist on ESME_RBINDFAIL", () => {
    expect(describeConnectionError("smpp client: bind rejected: ESME_RBINDFAIL", ep)).toMatch(/whitelisted our IP/);
  });
  it.each([
    "dial: dial tcp 10.0.0.5:2775: connect: connection refused",
    "dial: dial tcp 10.0.0.5:2775: i/o timeout",
    "dial: dial tcp 10.0.0.5:2775: connect: no route to host",
    "dial: context deadline exceeded",
  ])("unreachable host: %s", (raw) => {
    expect(describeConnectionError(raw, ep)).toMatch(/^Cannot reach 10\.0\.0\.5:2775/);
  });
  it("DNS, TLS, bind timeout, peer close", () => {
    expect(describeConnectionError("dial: dial tcp: lookup smsc.nope on 127.0.0.53:53: no such host", { host: "smsc.nope", port: 2775 })).toBe(
      "Host name “smsc.nope” not found (DNS)",
    );
    expect(describeConnectionError("dial: tls: first record does not look like a TLS handshake", ep)).toMatch(/^TLS handshake failed/);
    expect(describeConnectionError("bind: context deadline exceeded", ep)).toMatch(/did not answer the login/);
    expect(describeConnectionError("bind: EOF", ep)).toMatch(/closed the connection/);
    expect(describeConnectionError("password cannot be decrypted: cipher: message authentication failed", ep)).toMatch(/Enter the password again/);
  });
  it("falls back to the raw text", () => {
    expect(describeConnectionError("something odd", ep)).toBe("something odd");
  });
});

describe("connectionStateView", () => {
  it("maps states to tones", () => {
    expect(connectionStateView("BOUND").tone).toBe("success");
    expect(connectionStateView("CONNECTING").tone).toBe("warning");
    expect(connectionStateView("DOWN").tone).toBe("destructive");
    expect(connectionStateView("DISABLED").tone).toBe("muted");
    expect(connectionStateView("UNKNOWN").label).toBe("Waiting for engine");
  });
});
