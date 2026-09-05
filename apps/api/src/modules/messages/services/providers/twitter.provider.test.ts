import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TwitterProvider, extractTweetId, isRealTweetImage, stripOEmbedHtml } from "./twitter.provider.js";

// Pure-function unit tests — no I/O.

describe("extractTweetId()", () => {
  const cases: Array<{ url: string; expected: string | null }> = [
    { url: "https://x.com/user/status/1234567890", expected: "1234567890" },
    { url: "https://twitter.com/user/status/42", expected: "42" },
    { url: "https://x.com/user/status/42?s=20", expected: "42" },
    { url: "https://x.com/user/status/42/photo/1", expected: "42" },
    { url: "https://x.com/user", expected: null },
    { url: "https://x.com/home", expected: null },
    { url: "not a url at all", expected: null },
  ];
  for (const { url, expected } of cases) {
    it(`${url} → ${expected}`, () => assert.equal(extractTweetId(url), expected));
  }
});

describe("isRealTweetImage()", () => {
  it("accepts pbs.twimg.com", () => assert.equal(isRealTweetImage("https://pbs.twimg.com/media/abc.jpg"), true));
  it("accepts video.twimg.com", () => assert.equal(isRealTweetImage("https://video.twimg.com/thumb.jpg"), true));
  it("rejects abs.twimg.com (the bot-detection page's emoji image)", () => assert.equal(isRealTweetImage("https://abs.twimg.com/emoji/v2/72x72/1f600.png"), false));
  it("rejects an unrelated host", () => assert.equal(isRealTweetImage("https://example.com/img.jpg"), false));
  it("rejects null/undefined", () => {
    assert.equal(isRealTweetImage(null), false);
    assert.equal(isRealTweetImage(undefined), false);
  });
  it("rejects an unparseable URL", () => assert.equal(isRealTweetImage("not a url"), false));
});

describe("stripOEmbedHtml() — oEmbed HTML-stripping chain", () => {
  it("strips a trailing pic.twitter.com media anchor", () => {
    const html = '<blockquote>Check this out <a href="https://t.co/abc">pic.twitter.com/abc</a></blockquote>';
    assert.equal(stripOEmbedHtml(html), "Check this out");
  });

  it("strips a trailing t.co link anchor", () => {
    const html = '<blockquote>Read more <a href="https://t.co/xyz">t.co/xyz</a></blockquote>';
    assert.equal(stripOEmbedHtml(html), "Read more");
  });

  it("strips all other HTML tags", () => {
    const html = "<blockquote><p>Hello <b>world</b></p></blockquote>";
    assert.equal(stripOEmbedHtml(html), "Hello world");
  });

  it("cuts the &mdash; attribution line", () => {
    const html = "<blockquote>The actual tweet text&mdash; Author Name (@handle) January 1, 2026</blockquote>";
    assert.equal(stripOEmbedHtml(html), "The actual tweet text");
  });

  it("unescapes &amp; &lt; &gt; &quot; &#39;", () => {
    const html = "<blockquote>Tom &amp; Jerry: &quot;5 &lt; 10 &gt; 2&quot; it&#39;s true</blockquote>";
    assert.equal(stripOEmbedHtml(html), 'Tom & Jerry: "5 < 10 > 2" it\'s true');
  });

  it("collapses whitespace and trims", () => {
    const html = "<blockquote>  spaced    out   text  </blockquote>";
    assert.equal(stripOEmbedHtml(html), "spaced out text");
  });

  it("caps length at 280 characters", () => {
    const html = `<blockquote>${"a".repeat(400)}</blockquote>`;
    const result = stripOEmbedHtml(html);
    assert.equal(result?.length, 280);
  });

  it("returns null for an empty result (e.g. HTML with nothing but a media anchor)", () => {
    const html = '<blockquote><a href="x">pic.twitter.com/abc</a></blockquote>';
    assert.equal(stripOEmbedHtml(html), null);
  });

  it("applies the full chain together: tags stripped, media anchor dropped, attribution cut, entities unescaped", () => {
    const html =
      '<blockquote>Breaking: it&#39;s &quot;huge&quot; news <a href="https://t.co/abc">pic.twitter.com/abc</a>' +
      "&mdash; Reporter (@reporter) January 1, 2026</blockquote>";
    assert.equal(stripOEmbedHtml(html), 'Breaking: it\'s "huge" news');
  });
});

describe("TwitterProvider.canHandle()", () => {
  const provider = new TwitterProvider();
  it("accepts twitter.com, x.com, t.co, and their www. variants", () => {
    assert.equal(provider.canHandle("https://twitter.com/user"), true);
    assert.equal(provider.canHandle("https://www.twitter.com/user"), true);
    assert.equal(provider.canHandle("https://x.com/user"), true);
    assert.equal(provider.canHandle("https://www.x.com/user"), true);
    assert.equal(provider.canHandle("https://t.co/abc123"), true);
  });
  it("rejects an unrelated host", () => assert.equal(provider.canHandle("https://example.com"), false));
  it("rejects an unparseable URL", () => assert.equal(provider.canHandle("not a url"), false));
});
