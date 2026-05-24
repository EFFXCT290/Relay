import type { EmbedProvider, EmbedResult } from "./types.js";
import { safeImageUrl } from "./utils.js";
import ogs from "open-graph-scraper";

// Instagram serves real OG data (post image + caption) to Meta's own crawlers.
const FB_CRAWLER_UA =
  "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)";

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

      // og:url contains /username/p/shortcode/ — extract the handle.
      const userMatch = result.ogUrl?.match(/instagram\.com\/([^/]+)\/[pr]\//);
      const username = userMatch?.[1] ?? null;

      // og:title format: "{Display Name} on Instagram: \"{caption}\""
      const captionMatch = result.ogTitle?.match(/on Instagram:\s*"([\s\S]*)"\s*$/);
      const caption = captionMatch?.[1]?.trim().slice(0, 300) ?? result.ogDescription?.slice(0, 300) ?? null;

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
