import type { EmbedProvider, EmbedResult } from "./types.js";
import { safeImageUrl } from "./utils.js";

export class YouTubeProvider implements EmbedProvider {
  canHandle(url: string): boolean {
    try {
      const h = new URL(url).hostname.replace(/^www\./, "");
      return h === "youtube.com" || h === "youtu.be";
    } catch {
      return false;
    }
  }

  async fetch(url: string): Promise<EmbedResult | null> {
    // YouTube oEmbed is official + reliable — returns hq thumbnail directly.
    try {
      const endpoint = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
      const res = await fetch(endpoint, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return null;
      const data = await res.json() as {
        title?: string;
        author_name?: string;
        thumbnail_url?: string;
      };
      return {
        url,
        title:       data.title                       ?? null,
        description: data.author_name                 ?? null,
        imageUrl:    safeImageUrl(data.thumbnail_url),
        siteName:    "YouTube",
        faviconUrl:  null,
        type:        "video",
        provider:    "youtube" as const,
      };
    } catch {
      return null;
    }
  }
}
