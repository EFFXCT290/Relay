import type { EmbedProvider } from "./providers/types.js";
import { YouTubeProvider } from "./providers/youtube.provider.js";
import { TikTokProvider } from "./providers/tiktok.provider.js";
import { TwitterProvider } from "./providers/twitter.provider.js";
import { InstagramProvider } from "./providers/instagram.provider.js";
import { GenericProvider } from "./providers/generic.provider.js";
import { normalizeUrl } from "./providers/utils.js";

export type { EmbedResult } from "./providers/types.js";

// True for a dotted-decimal IPv4 string in a loopback/private/link-local
// range this guard rejects. Shared by the plain-hostname check and the
// IPv4-mapped-IPv6 check below so both apply identical range logic instead
// of two copies that can drift out of sync.
function isBlockedIPv4(ip: string): boolean {
  if (
    ip === "0.0.0.0" ||
    ip.startsWith("127.") ||
    ip.startsWith("10.") ||
    ip.startsWith("192.168.") ||
    ip.startsWith("169.254.")
  ) return true;
  const m = ip.match(/^172\.(\d+)\./);
  return !!m && Number(m[1]) >= 16 && Number(m[1]) <= 31;
}

// IPv4-mapped IPv6 (RFC 4291 §2.5.5.2) re-expresses any IPv4 address as an
// IPv6 literal. The WHATWG URL parser always normalizes these to the
// compressed hex form in u.hostname — e.g. "::ffff:127.0.0.1" becomes
// "::ffff:7f00:1" — so every blocked IPv4 range above could otherwise be
// smuggled past a plain hostname-string check. Decode it back to
// dotted-decimal and re-run the same range check on it.
function mappedIPv4(host: string): string | null {
  const m = host.replace(/^\[|\]$/g, "").match(/^(?:0*:){0,5}ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (!m) return null;
  const hi = parseInt(m[1]!, 16);
  const lo = parseInt(m[2]!, 16);
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
}

// SSRF guard — blocks private/loopback ranges before any provider runs.
export function isSafeUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    const h = u.hostname.toLowerCase();
    if (h === "localhost" || h === "::1" || h === "[::1]") return false;
    if (isBlockedIPv4(h)) return false;
    const mapped = mappedIPv4(h);
    if (mapped && isBlockedIPv4(mapped)) return false;
    return true;
  } catch {
    return false;
  }
}

// Ordered by specificity — first match wins. GenericProvider is the catch-all.
const PROVIDERS: EmbedProvider[] = [
  new YouTubeProvider(),
  new TikTokProvider(),
  new TwitterProvider(),
  new InstagramProvider(),
  new GenericProvider(),
];

export async function fetchEmbed(url: string) {
  const normalized = normalizeUrl(url);
  if (!isSafeUrl(normalized)) return null;

  for (const provider of PROVIDERS) {
    if (provider.canHandle(normalized)) {
      return provider.fetch(normalized);
    }
  }

  return null;
}
