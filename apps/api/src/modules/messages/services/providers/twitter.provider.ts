import type { EmbedProvider, EmbedResult } from "./types.js";
import { tryOpenGraph, safeImageUrl } from "./utils.js";

function extractTweetId(url: string): string | null {
  // Matches: https://x.com/user/status/123 or https://twitter.com/user/status/123
  const m = url.match(/\/status\/(\d+)/);
  return m?.[1] ?? null;
}

// Twitter's bot-detection page serves abs.twimg.com/emoji/ as the OG image.
// Real tweet media comes from pbs.twimg.com or video.twimg.com.
function isRealTweetImage(rawUrl: string | null | undefined): boolean {
  if (!rawUrl) return false;
  try {
    const h = new URL(rawUrl).hostname;
    return h === "pbs.twimg.com" || h === "video.twimg.com";
  } catch {
    return false;
  }
}

export class TwitterProvider implements EmbedProvider {
  canHandle(url: string): boolean {
    try {
      const h = new URL(url).hostname.replace(/^www\./, "");
      return h === "twitter.com" || h === "x.com" || h === "t.co";
    } catch {
      return false;
    }
  }

  async fetch(url: string): Promise<EmbedResult | null> {
    const tweetId = extractTweetId(url);

    // Run all three fetches in parallel to keep latency low.
    const [imageUrl, oembed, og] = await Promise.all([
      tweetId ? this.tryJfImage(tweetId) : Promise.resolve(null),
      this.tryOEmbed(url),
      tryOpenGraph(url),
    ]);

    // OGS returns real tweet media (pbs.twimg.com) when the tweet has attached
    // images/videos — use it. Ignore abs.twimg.com/emoji (X's error-page image).
    const ogImage = isRealTweetImage(og?.imageUrl) ? safeImageUrl(og!.imageUrl) : null;
    const bestImage = imageUrl ?? ogImage;

    // Always return a branded card — never null for an X/Twitter URL.
    return {
      url,
      title:       oembed?.author ? `@${oembed.author}` : "X / Twitter",
      description: oembed?.text   ?? null,
      imageUrl:    bestImage,
      siteName:    "X",
      faviconUrl:  null,
      type:        "rich",
      provider:    "twitter" as const,
    };
  }

  private async tryJfImage(tweetId: string): Promise<string | null> {
    const url = `https://jf.x.com/images/post/${tweetId}.png`;
    try {
      // jf.x.com returns 500 for HEAD — use GET and cancel the body immediately.
      const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
      void res.body?.cancel();
      return res.ok ? url : null;
    } catch {
      return null;
    }
  }

  private async tryOEmbed(url: string): Promise<{ author: string; text: string | null } | null> {
    try {
      const endpoint = `https://publish.twitter.com/oembed?url=${encodeURIComponent(url)}&omit_script=true`;
      const res = await fetch(endpoint, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return null;
      const data = await res.json() as { author_name?: string; html?: string };
      if (!data.author_name) return null;

      let text: string | null = null;
      if (data.html) {
        text = data.html
          .replace(/<a\b[^>]*>(?:pic\.twitter\.com|t\.co)[^<]*<\/a>/gi, "")
          .replace(/<[^>]+>/g, " ")
          .replace(/&mdash;.*$/s, "")
          .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
          .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
          .replace(/\s+/g, " ").trim().slice(0, 280) || null;
      }

      return { author: data.author_name, text };
    } catch {
      return null;
    }
  }
}
