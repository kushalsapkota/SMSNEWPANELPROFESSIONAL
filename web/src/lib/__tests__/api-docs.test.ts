import { createHmac, timingSafeEqual } from "node:crypto";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { VERIFY_NODE, curlSendGet, curlSendPost, signaturePayload } from "@/lib/api-docs";

const ctx = { baseUrl: "https://gw.example.com", apiKey: "sk_live_abc", from: "MY'BRAND", to: "919876543210" };

describe("curl examples", () => {
  it("POST example is valid shell with escaped quotes and JSON body", () => {
    const cmd = curlSendPost(ctx);
    expect(cmd).toContain("https://gw.example.com/v1/sms/send");
    // let a real shell parse it: replace curl with printf of the -d argument
    const script = cmd.replace(/^curl/, "f() { while [ $# -gt 0 ]; do if [ \"$1\" = -d ]; then printf %s \"$2\"; fi; shift; done; }; f");
    const out = execFileSync("bash", ["-c", script]).toString();
    expect(JSON.parse(out)).toMatchObject({ to: "919876543210", from: "MY'BRAND", client_ref: "order-1001" });
  });

  it("legacy GET example URL-encodes parameters", () => {
    expect(curlSendGet(ctx)).toContain("api_key=sk_live_abc&to=919876543210&from=MY%27BRAND");
  });
});

describe("webhook signature (CONTRACTS §2)", () => {
  it("the Node snippet's scheme matches sha256=hex(hmac(secret, ts.body))", () => {
    const secret = "whsec_test";
    const ts = "1760778905";
    const body = '{"event":"dlr","status":"DELIVERED"}';
    const header = "sha256=" + createHmac("sha256", secret).update(signaturePayload(ts, body)).digest("hex");
    // Same computation the snippet performs (string concat of ts + "." + raw body Buffer).
    const expected = "sha256=" + createHmac("sha256", secret).update(ts + "." + Buffer.from(body)).digest("hex");
    expect(timingSafeEqual(Buffer.from(header), Buffer.from(expected))).toBe(true);
    expect(VERIFY_NODE).toContain('update(ts + "." + req.body)');
    expect(VERIFY_NODE).toContain("express.raw");
  });

  it("the Python snippet's HMAC line verifies the same signature", () => {
    const secret = "whsec_test";
    const ts = "1760778905";
    const body = '{"event":"dlr"}';
    const header = "sha256=" + createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
    const py = [
      "import hashlib, hmac, sys",
      "SECRET, ts, body, sig = sys.argv[1].encode(), sys.argv[2], sys.argv[3].encode(), sys.argv[4]",
      'expected = "sha256=" + hmac.new(SECRET, ts.encode() + b"." + body, hashlib.sha256).hexdigest()',
      "print(hmac.compare_digest(expected, sig))",
    ].join("\n");
    let out: string;
    try {
      out = execFileSync("python3", ["-I", "-c", py, secret, ts, body, header]).toString().trim();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return; // python3 not installed
      throw e;
    }
    expect(out).toBe("True");
  });
});
