/**
 * Validate a post-sign-in destination taken from the query string.
 *
 * Only same-origin, absolute *paths* are accepted. Anything else — full URLs,
 * protocol-relative `//evil.example`, backslashes (which some browsers
 * normalise into `/`), control characters — falls back to `fallback`, which
 * closes the open-redirect hole a `?next=` parameter otherwise creates.
 */
export function safeRedirectPath(raw: string | null | undefined, fallback = "/"): string {
  if (!raw || typeof raw !== "string") return fallback;
  if (!raw.startsWith("/") || raw.startsWith("//")) return fallback;
  if (raw.includes("\\") || hasControlCharacter(raw)) return fallback;
  // Never bounce back into the auth pages themselves.
  if (/^\/(signin|signout|join)(\/|\?|#|$)/.test(raw)) return fallback;
  return raw;
}

/** C0 controls and DEL. Checked by code point to keep the source plain ASCII. */
function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}
