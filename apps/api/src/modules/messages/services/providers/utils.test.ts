import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeUrl, safeImageUrl, hostnameOf } from "./utils.js";

// Pure-function unit tests — no I/O, no mocking needed.

describe("normalizeUrl()", () => {
  describe("tracking-param stripping", () => {
    it("strips utm_* params, keeps unrelated ones", () => {
      const out = normalizeUrl("https://example.com/page?utm_source=share&utm_campaign=x&foo=bar");
      assert.equal(out, "https://example.com/page?foo=bar");
    });

    it("strips fbclid, ref_src, ref_url on any host", () => {
      const out = normalizeUrl("https://example.com/page?fbclid=abc&ref_src=twsrc&ref_url=xyz&keep=me");
      assert.equal(out, "https://example.com/page?keep=me");
    });

    it("strips Twitter's short s/t tokens — but only on twitter.com/x.com", () => {
      const out = normalizeUrl("https://x.com/user/status/123?s=20&t=abcDEF");
      assert.equal(out, "https://x.com/user/status/123");
    });

    it("does NOT strip a generic 's' or 't' param on a non-Twitter host (regression: these collided with legitimate params elsewhere)", () => {
      const out = normalizeUrl("https://example.com/search?s=query&t=5");
      assert.equal(out, "https://example.com/search?s=query&t=5");
    });
  });

  describe("twitter.com → x.com canonicalization", () => {
    it("rewrites twitter.com to x.com, preserving path", () => {
      assert.equal(normalizeUrl("https://twitter.com/user/status/123"), "https://x.com/user/status/123");
    });

    it("rewrites www.twitter.com to x.com (not www.x.com)", () => {
      assert.equal(normalizeUrl("https://www.twitter.com/user"), "https://x.com/user");
    });

    it("leaves x.com itself unchanged (aside from its own s/t stripping)", () => {
      assert.equal(normalizeUrl("https://x.com/user/status/123"), "https://x.com/user/status/123");
    });
  });

  describe("youtu.be rewrite", () => {
    it("rewrites youtu.be/VIDEO_ID to youtube.com/watch?v=VIDEO_ID", () => {
      assert.equal(normalizeUrl("https://youtu.be/dQw4w9WgXcQ"), "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    });

    it("regression: a youtu.be timestamp (?t=42) survives normalization — previously silently dropped by the shared Twitter tracking-param list", () => {
      const out = normalizeUrl("https://youtu.be/dQw4w9WgXcQ?t=42");
      const url = new URL(out);
      assert.equal(url.hostname, "www.youtube.com");
      assert.equal(url.searchParams.get("v"), "dQw4w9WgXcQ");
      assert.equal(url.searchParams.get("t"), "42", "the start-time param must not be stripped for a non-Twitter host");
    });

    it("m.youtube.com is canonicalized to www.youtube.com", () => {
      assert.equal(normalizeUrl("https://m.youtube.com/watch?v=abc123"), "https://www.youtube.com/watch?v=abc123");
    });
  });

  describe("protocol allowlist / malformed input", () => {
    it("returns the raw string unchanged for an unparseable URL", () => {
      assert.equal(normalizeUrl("not a url"), "not a url");
    });

    it("passes through a URL with no tracking params or special host unchanged (aside from URL's own serialization)", () => {
      assert.equal(normalizeUrl("https://example.com/a/b/c"), "https://example.com/a/b/c");
    });
  });
});

describe("safeImageUrl()", () => {
  it("accepts http:// and https:// URLs", () => {
    assert.equal(safeImageUrl("https://example.com/img.jpg"), "https://example.com/img.jpg");
    assert.equal(safeImageUrl("http://example.com/img.jpg"), "http://example.com/img.jpg");
  });

  it("rejects non-http(s) protocols", () => {
    assert.equal(safeImageUrl("javascript:alert(1)"), null);
    assert.equal(safeImageUrl("data:image/png;base64,abc"), null);
    assert.equal(safeImageUrl("file:///etc/passwd"), null);
  });

  it("rejects an unparseable URL", () => {
    assert.equal(safeImageUrl("not a url"), null);
  });

  it("returns null for null/undefined/empty input", () => {
    assert.equal(safeImageUrl(null), null);
    assert.equal(safeImageUrl(undefined), null);
    assert.equal(safeImageUrl(""), null);
  });
});

describe("hostnameOf()", () => {
  it("strips a leading www.", () => {
    assert.equal(hostnameOf("https://www.example.com/page"), "example.com");
  });

  it("leaves a non-www hostname unchanged", () => {
    assert.equal(hostnameOf("https://example.com/page"), "example.com");
  });

  it("falls back to the raw input for an unparseable URL", () => {
    assert.equal(hostnameOf("not a url"), "not a url");
  });
});
