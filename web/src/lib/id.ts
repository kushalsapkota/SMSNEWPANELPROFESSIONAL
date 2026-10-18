/** Random idempotency key (works on plain-http origins where crypto.randomUUID is unavailable). */
export function newIdempotencyKey(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") {
    try {
      return `web-${c.randomUUID()}`;
    } catch {
      /* insecure context */
    }
  }
  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === "function") c.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return `web-${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}
