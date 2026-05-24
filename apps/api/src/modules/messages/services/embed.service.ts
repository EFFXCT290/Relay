import type { EmbedProvider } from "./providers/types.js";
import { YouTubeProvider } from "./providers/youtube.provider.js";
import { TikTokProvider } from "./providers/tiktok.provider.js";
import { TwitterProvider } from "./providers/twitter.provider.js";
import { InstagramProvider } from "./providers/instagram.provider.js";
import { GenericProvider } from "./providers/generic.provider.js";
import { normalizeUrl } from "./providers/utils.js";

export type { EmbedResult } from "./providers/types.js";

// SSRF guard — blocks private/loopback ranges before any provider runs.
function isSafeUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    const h = u.hostname.toLowerCase();
    if (
      h === "localhost" ||
      h === "::1" ||
      h === "[::1]" ||
      h.startsWith("127.") ||
      h.startsWith("10.") ||
      h.startsWith("192.168.") ||
      h.startsWith("169.254.")
    ) return false;
    const m = h.match(/^172\.(\d+)\./);
    if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return false;
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
