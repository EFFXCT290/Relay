import type { EmbedProvider, EmbedResult } from "./types.js";
import { safeImageUrl } from "./utils.js";
import ogs from "open-graph-scraper";

// Instagram serves real OG data (post image + caption) to Meta's own crawlers.
const FB_CRAWLER_UA =
  "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)";

// og:url contains /username/p/shortcode/ (posts) or /username/reel/shortcode/
// (reels) — extract the handle. Matches p/r/reel as a superset so a canonical
// short form (if og:url ever reports one) is covered too.
export function extractInstagramUsername(ogUrl: string | undefined | null): string | null {
  const m = ogUrl?.match(/instagram\.com\/([^/]+)\/(?:p|r|reel)\//);
  return m?.[1] ?? null;
}

// og:title format: "{Display Name} on Instagram: \"{caption}\"" — falls back
// to og:description when og:title doesn't match that shape.
export function extractInstagramCaption(
  ogTitle:       string | undefined | null,
  ogDescription: string | undefined | null,
): string | null {
  const m = ogTitle?.match(/on Instagram:\s*"([\s\S]*)"\s*$/);
  return m?.[1]?.trim().slice(0, 300) ?? ogDescription?.slice(0, 300) ?? null;
}

export class InstagramProvider implements EmbedProvider {
  canHandle(url: string): boolean {
    try {
      const h = new URL(url).hostname.replace(/^www\./, "");
      return h === "instagram.com";
    } catch {
      return false;
    }
  }

  async fetch(url: string): Promise<EmbedResult | null> {
    try {
      const { result } = await ogs({
        url,
        timeout: 8,
        fetchOptions: { headers: { "user-agent": FB_CRAWLER_UA } } as never,
      });

      const imageUrl = safeImageUrl(result.ogImage?.[0]?.url);
      if (!imageUrl && !result.ogTitle) {
        // Login redirect — no real post data returned.
        return this.brandedFallback(url);
      }

      const username = extractInstagramUsername(result.ogUrl);
      const caption  = extractInstagramCaption(result.ogTitle, result.ogDescription);

      return {
        url,
        title:       username ? `@${username}` : null,
        description: caption,
        imageUrl,
        siteName:    "Instagram",
        faviconUrl:  null,
        type:        result.ogType ?? "rich",
        provider:    "instagram" as const,
      };
    } catch {
      return this.brandedFallback(url);
    }
  }

  private brandedFallback(url: string): EmbedResult {
    return {
      url,
      title:       null,
      description: null,
      imageUrl:    null,
      siteName:    "Instagram",
      faviconUrl:  null,
      type:        "rich",
      provider:    "instagram",
    };
  }
}
