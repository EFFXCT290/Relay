import type { EmbedProvider, EmbedResult } from "./types.js";
import { safeImageUrl, tryOpenGraph } from "./utils.js";

export class TikTokProvider implements EmbedProvider {
  canHandle(url: string): boolean {
    try {
      const h = new URL(url).hostname.replace(/^www\./, "");
      return h === "tiktok.com" || h === "vm.tiktok.com" || h === "vt.tiktok.com";
    } catch {
      return false;
    }
  }

  async fetch(url: string): Promise<EmbedResult | null> {
    // Step 1: OGS with browser headers.
    const og = await tryOpenGraph(url);
    if (og?.imageUrl) return { ...og, siteName: "TikTok", provider: "tiktok" as const };

    // Step 2: TikTok oEmbed — official API, returns thumbnail.
    try {
      const endpoint = `https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`;
      const res = await fetch(endpoint, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error("non-ok");
      const data = await res.json() as {
        title?: string;
        author_name?: string;
        thumbnail_url?: string;
      };
      return {
        url,
        title:       data.title                                   ?? null,
        description: data.author_name ? `@${data.author_name}` : null,
        imageUrl:    safeImageUrl(data.thumbnail_url),
        siteName:    "TikTok",
        faviconUrl:  null,
        type:        "video",
        provider:    "tiktok" as const,
      };
    } catch { /* fall through */ }

    // TikTok blocks most server-side scraping — branded fallback.
    return {
      url,
      title:       null,
      description: null,
      imageUrl:    null,
      siteName:    "TikTok",
      faviconUrl:  null,
      type:        "video",
      provider:    "tiktok" as const,
    };
  }
}
