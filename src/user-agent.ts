/**
 * A human label for a device, from its User-Agent — "iPhone · Safari".
 *
 * Only used to suggest a default passkey nickname and to label sessions, so
 * it deliberately stays coarse. Anything it can't place becomes "This device"
 * rather than a confident guess.
 */
export function describeUserAgent(ua: string | null | undefined): string {
  if (!ua) return "This device";

  const device = /iPhone/.test(ua)
    ? "iPhone"
    : /iPad/.test(ua)
      ? "iPad"
      : /Android/.test(ua)
        ? /Mobile/.test(ua)
          ? "Android phone"
          : "Android tablet"
        : /Macintosh|Mac OS X/.test(ua)
          ? "Mac"
          : /Windows/.test(ua)
            ? "Windows PC"
            : /CrOS/.test(ua)
              ? "Chromebook"
              : /Linux/.test(ua)
                ? "Linux PC"
                : null;

  // Order matters: Edge and Opera also claim Chrome, and every Chromium
  // browser claims Safari.
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /OPR\//.test(ua)
      ? "Opera"
      : /Firefox\/|FxiOS\//.test(ua)
        ? "Firefox"
        : /Chrome\/|CriOS\//.test(ua)
          ? "Chrome"
          : /Safari\//.test(ua)
            ? "Safari"
            : null;

  if (device && browser) return `${device} · ${browser}`;
  return device ?? browser ?? "This device";
}
