import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TikTokProvider } from "./tiktok.provider.js";

// tiktok.provider.ts's fetch() is a 3-tier fallback chain: OGS (via
// utils.ts's tryOpenGraph) → TikTok's own oEmbed API (global fetch) →
// a branded fallback with no network call at all. Each test below mocks
// exactly the tiers needed to prove the SHORT-CIRCUIT ORDERING — that a
// later tier is never attempted once an earlier one succeeds — not just
// that each tier works in isolation.

describe("TikTokProvider.canHandle()", () => {
  const provider = new TikTokProvider();
  it("accepts tiktok.com, vm.tiktok.com, vt.tiktok.com, and www. variants", () => {
    assert.equal(provider.canHandle("https://tiktok.com/@user/video/123"), true);
    assert.equal(provider.canHandle("https://www.tiktok.com/@user/video/123"), true);
    assert.equal(provider.canHandle("https://vm.tiktok.com/abc123"), true);
    assert.equal(provider.canHandle("https://vt.tiktok.com/abc123"), true);
  });
  it("rejects an unrelated host", () => assert.equal(provider.canHandle("https://example.com"), false));
  it("rejects an unparseable URL", () => assert.equal(provider.canHandle("not a url"), false));
});

describe("TikTokProvider.fetch() — 3-tier fallback, short-circuit ordering", () => {
  it("tier 1 (OGS) succeeds → returns immediately, tier 2 (oEmbed fetch) is never attempted", async (t) => {
    const utilsUrl = new URL("./utils.js", import.meta.url).href;
    t.mock.module(utilsUrl, {
      namedExports: {
        safeImageUrl: (u: string | null | undefined) => u ?? null,
        tryOpenGraph: async () => ({
          url: "https://tiktok.com/@user/video/123",
          title: "OGS title",
          description: null,
          imageUrl: "https://ogs.example/thumb.jpg",
          siteName: null,
          faviconUrl: null,
          type: "video",
        }),
      },
    });
    let fetchCalled = false;
    t.mock.method(globalThis, "fetch", async () => {
      fetchCalled = true;
      throw new Error("tier 2 must not be reached when tier 1 succeeds");
    });

    const { TikTokProvider: FreshProvider } = await import(`./tiktok.provider.js?t=${Math.random()}`);
    const provider = new FreshProvider();
    const result = await provider.fetch("https://tiktok.com/@user/video/123");

    assert.equal(fetchCalled, false, "tier 2 (fetch) must not run when tier 1 (OGS) already returned an image");
    assert.equal(result.title, "OGS title");
    assert.equal(result.imageUrl, "https://ogs.example/thumb.jpg");
    assert.equal(result.siteName, "TikTok");
    assert.equal(result.provider, "tiktok");
  });

  it("tier 1 fails (no image) → falls through to tier 2 (oEmbed), which succeeds", async (t) => {
    const utilsUrl = new URL("./utils.js", import.meta.url).href;
    t.mock.module(utilsUrl, {
      namedExports: {
        safeImageUrl: (u: string | null | undefined) => u ?? null,
        tryOpenGraph: async () => null, // tier 1: no usable OG data
      },
    });
    let fetchCallCount = 0;
    t.mock.method(globalThis, "fetch", async (url: string) => {
      fetchCallCount++;
      assert.match(String(url), /tiktok\.com\/oembed/, "tier 2 must call TikTok's oEmbed endpoint");
      return {
        ok: true,
        json: async () => ({ title: "oEmbed title", author_name: "someauthor", thumbnail_url: "https://oembed.example/thumb.jpg" }),
      };
    });

    const { TikTokProvider: FreshProvider } = await import(`./tiktok.provider.js?t=${Math.random()}`);
    const provider = new FreshProvider();
    const result = await provider.fetch("https://tiktok.com/@user/video/123");

    assert.equal(fetchCallCount, 1, "tier 2 must be attempted exactly once when tier 1 fails");
    assert.equal(result.title, "oEmbed title");
    assert.equal(result.description, "@someauthor");
    assert.equal(result.imageUrl, "https://oembed.example/thumb.jpg");
    assert.equal(result.provider, "tiktok");
  });

  it("both tier 1 and tier 2 fail → branded fallback, no data leaks through", async (t) => {
    const utilsUrl = new URL("./utils.js", import.meta.url).href;
    t.mock.module(utilsUrl, {
      namedExports: {
        safeImageUrl: (u: string | null | undefined) => u ?? null,
        tryOpenGraph: async () => null,
      },
    });
    t.mock.method(globalThis, "fetch", async () => ({ ok: false }));

    const { TikTokProvider: FreshProvider } = await import(`./tiktok.provider.js?t=${Math.random()}`);
    const provider = new FreshProvider();
    const result = await provider.fetch("https://tiktok.com/@user/video/123");

    assert.deepEqual(result, {
      url: "https://tiktok.com/@user/video/123",
      title: null,
      description: null,
      imageUrl: null,
      siteName: "TikTok",
      faviconUrl: null,
      type: "video",
      provider: "tiktok",
    });
  });

  it("tier 2 throwing (network error) also falls through to the branded fallback", async (t) => {
    const utilsUrl = new URL("./utils.js", import.meta.url).href;
    t.mock.module(utilsUrl, {
      namedExports: {
        safeImageUrl: (u: string | null | undefined) => u ?? null,
        tryOpenGraph: async () => null,
      },
    });
    t.mock.method(globalThis, "fetch", async () => { throw new Error("network down"); });

    const { TikTokProvider: FreshProvider } = await import(`./tiktok.provider.js?t=${Math.random()}`);
    const provider = new FreshProvider();
    const result = await provider.fetch("https://tiktok.com/@user/video/123");

    assert.equal(result.siteName, "TikTok");
    assert.equal(result.title, null);
  });
});
