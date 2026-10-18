const DEFAULT_NEXT = "/dashboard";
// Placeholder origin used only to resolve the candidate path; any value that
// resolves to a different origin is an off-site redirect and is rejected.
const PROBE_ORIGIN = "http://same-origin.invalid";

/**
 * Sanitize a post-login `next` target so it can only ever point at a path on
 * this site. Browsers (and the WHATWG URL parser used by the Next router)
 * treat `\` like `/` and strip tab/newline characters, so values such as
 * `/\evil.com` or `/\t/evil.com` resolve to `https://evil.com/`. We therefore
 * reject backslashes and control characters outright, resolve the value
 * against a fixed origin, require the origin to be unchanged, and return the
 * normalized path rather than the raw input.
 */
export function safeNext(next: string | null | undefined, fallback: string = DEFAULT_NEXT): string {
  if (!next || !next.startsWith("/") || next.startsWith("//")) return fallback;
  // eslint-disable-next-line no-control-regex
  if (/[\\\u0000-\u001f\u007f]/.test(next)) return fallback;
  let url: URL;
  try {
    url = new URL(next, PROBE_ORIGIN);
  } catch {
    return fallback;
  }
  if (url.origin !== PROBE_ORIGIN) return fallback;
  // Dot-segment normalization can turn `/.//evil.com` into the protocol-relative
  // `//evil.com`; re-check the normalized path before handing it to the router.
  if (url.pathname.startsWith("//")) return fallback;
  if (url.pathname === "/login" || url.pathname.startsWith("/login/")) return fallback;
  return `${url.pathname}${url.search}${url.hash}`;
}
