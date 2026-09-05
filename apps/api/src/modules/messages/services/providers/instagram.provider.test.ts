import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { InstagramProvider, extractInstagramUsername, extractInstagramCaption } from "./instagram.provider.js";

describe("extractInstagramUsername()", () => {
  it("extracts the handle from a post URL", () => {
    assert.equal(extractInstagramUsername("https://www.instagram.com/someuser/p/Cabc123/"), "someuser");
  });
  it("extracts the handle from a reel URL (/reel/, not a bare /r/)", () => {
    assert.equal(extractInstagramUsername("https://www.instagram.com/someuser/reel/Cabc123/"), "someuser");
  });
  it("also matches a bare /r/ short-form segment, if og:url ever reports one", () => {
    assert.equal(extractInstagramUsername("https://www.instagram.com/someuser/r/Cabc123/"), "someuser");
  });
  it("returns null when the URL has no /p/ or /r/ segment", () => {
    assert.equal(extractInstagramUsername("https://www.instagram.com/someuser/"), null);
  });
  it("returns null for undefined/null input", () => {
    assert.equal(extractInstagramUsername(undefined), null);
    assert.equal(extractInstagramUsername(null), null);
  });
});

describe("extractInstagramCaption()", () => {
  it("extracts the caption from the standard og:title format", () => {
    const title = 'Jane Doe on Instagram: "Having a great day at the beach!"';
    assert.equal(extractInstagramCaption(title, null), "Having a great day at the beach!");
  });
  it("trims and caps the caption at 300 characters", () => {
    const long = "x".repeat(400);
    const title = `Jane Doe on Instagram: "  ${long}  "`;
    const result = extractInstagramCaption(title, null);
    assert.equal(result?.length, 300);
  });
  it("falls back to og:description when og:title doesn't match the expected shape", () => {
    assert.equal(extractInstagramCaption("Some other title format", "the description instead"), "the description instead");
  });
  it("falls back to og:description when og:title is missing entirely", () => {
    assert.equal(extractInstagramCaption(null, "the description instead"), "the description instead");
  });
  it("returns null when neither is present or matches", () => {
    assert.equal(extractInstagramCaption(null, null), null);
    assert.equal(extractInstagramCaption("no match here", null), null);
  });
});

describe("InstagramProvider.canHandle()", () => {
  const provider = new InstagramProvider();
  it("accepts instagram.com and www.instagram.com", () => {
    assert.equal(provider.canHandle("https://instagram.com/user"), true);
    assert.equal(provider.canHandle("https://www.instagram.com/user"), true);
  });
  it("rejects an unrelated host", () => assert.equal(provider.canHandle("https://example.com"), false));
  it("rejects an unparseable URL", () => assert.equal(provider.canHandle("not a url"), false));
});

describe("InstagramProvider.fetch() — login-redirect → branded-fallback detection", () => {
  it("returns real post data when ogs() returns an image and/or title", async (t) => {
    t.mock.module("open-graph-scraper", {
      defaultExport: async () => ({
        result: {
          ogImage: [{ url: "https://scontent.cdninstagram.com/photo.jpg" }],
          ogUrl: "https://www.instagram.com/someuser/p/Cabc123/",
          ogTitle: 'Jane Doe on Instagram: "A real caption here"',
          ogType: "instapp:photo",
        },
      }),
    });
    const { InstagramProvider: FreshProvider } = await import(`./instagram.provider.js?t=${Math.random()}`);
    const provider = new FreshProvider();
    const result = await provider.fetch("https://www.instagram.com/someuser/p/Cabc123/");

    assert.equal(result.title, "@someuser");
    assert.equal(result.description, "A real caption here");
    assert.equal(result.imageUrl, "https://scontent.cdninstagram.com/photo.jpg");
    assert.equal(result.siteName, "Instagram");
    assert.equal(result.provider, "instagram");
  });

  it("falls back to the branded card when ogs() returns neither an image nor a title (login redirect)", async (t) => {
    t.mock.module("open-graph-scraper", {
      defaultExport: async () => ({ result: {} }), // no ogImage, no ogTitle — exactly the login-redirect shape
    });
    const { InstagramProvider: FreshProvider } = await import(`./instagram.provider.js?t=${Math.random()}`);
    const provider = new FreshProvider();
    const result = await provider.fetch("https://www.instagram.com/someuser/p/Cabc123/");

    assert.deepEqual(result, {
      url: "https://www.instagram.com/someuser/p/Cabc123/",
      title: null,
      description: null,
      imageUrl: null,
      siteName: "Instagram",
      faviconUrl: null,
      type: "rich",
      provider: "instagram",
    });
  });

  it("falls back to the branded card when ogs() itself throws", async (t) => {
    t.mock.module("open-graph-scraper", {
      defaultExport: async () => { throw new Error("network error"); },
    });
    const { InstagramProvider: FreshProvider } = await import(`./instagram.provider.js?t=${Math.random()}`);
    const provider = new FreshProvider();
    const result = await provider.fetch("https://www.instagram.com/someuser/p/Cabc123/");

    assert.equal(result.siteName, "Instagram");
    assert.equal(result.title, null);
    assert.equal(result.imageUrl, null);
  });
});
