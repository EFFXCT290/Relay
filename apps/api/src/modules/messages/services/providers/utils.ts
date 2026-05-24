import ogs from "open-graph-scraper";
import type { EmbedResult } from "./types.js";

// Params that carry zero semantic meaning and are tracking-only.
const TRACKING_PARAMS = new Set([
  "fbclid", "ref_src", "ref_url",
  // Twitter/X tracking tokens
  "s", "t",
]);

export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw);

    // Strip utm_* and known tracking params.
    for (const key of [...u.searchParams.keys()]) {
      if (key.startsWith("utm_") || TRACKING_PARAMS.has(key)) {
        u.searchParams.delete(key);
      }
    }

    const host = u.hostname.toLowerCase();

    // twitter.com → x.com (canonical domain)
    if (host === "twitter.com" || host === "www.twitter.com") {
      u.hostname = "x.com";
    }

    // youtu.be/VIDEO_ID → youtube.com/watch?v=VIDEO_ID
    if (host === "youtu.be") {
      const videoId = u.pathname.slice(1);
      u.hostname = "www.youtube.com";
      u.pathname = "/watch";
      u.searchParams.set("v", videoId);
    }

    // m.youtube.com → www.youtube.com
    if (host === "m.youtube.com") {
      u.hostname = "www.youtube.com";
    }

    return u.toString();
  } catch {
    return raw;
  }
}

export const BROWSER_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
  "accept-language": "en-US,en;q=0.9",
};

export function safeImageUrl(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

export function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

// Shared OGS call with browser headers — used by all providers as Step 1.
// Returns the full shape minus `provider` — callers tag that themselves.
export async function tryOpenGraph(url: string): Promise<Omit<EmbedResult, "provider"> | null> {
  try {
    const { result } = await ogs({
      url,
      timeout: 5,
      fetchOptions: { headers: BROWSER_HEADERS } as never,
    });

    if (!result.ogTitle && !result.ogImage?.[0]?.url) return null;

    return {
      url,
      title:       result.ogTitle       ?? null,
      description: result.ogDescription ?? null,
      imageUrl:    safeImageUrl(result.ogImage?.[0]?.url),
      siteName:    result.ogSiteName    ?? null,
      faviconUrl:  safeImageUrl(result.favicon),
      type:        result.ogType        ?? null,
    };
  } catch {
    return null;
  }
}
