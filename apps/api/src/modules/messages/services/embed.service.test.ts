import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isSafeUrl } from "./embed.service.js";

// Pure-function unit tests for the SSRF guard fetchEmbed() runs before ever
// issuing a real outbound request for a user-supplied URL (link previews).
// Table-driven, with explicit boundary cases — off-by-one errors are exactly
// what hide in range logic like the 172.16.0.0/12 check below.

describe("embed.service.ts — isSafeUrl() SSRF guard", () => {
  describe("localhost / loopback variants → rejected", () => {
    const cases = [
      "http://localhost/",
      "https://localhost/",
      "http://LOCALHOST/",
      "http://127.0.0.1/",
      "http://127.0.0.1:8080/path",
      "http://127.1.2.3/",
      "http://127.255.255.255/",
      "http://[::1]/",
      "http://[::1]:3000/",
    ];
    for (const url of cases) {
      it(`rejects ${url}`, () => assert.equal(isSafeUrl(url), false));
    }
  });

  describe("RFC1918 private ranges → rejected", () => {
    const cases = [
      "http://192.168.0.1/",
      "http://192.168.255.255/",
      "http://10.0.0.1/",
      "http://10.255.255.255/",
      "http://169.254.1.1/",
    ];
    for (const url of cases) {
      it(`rejects ${url}`, () => assert.equal(isSafeUrl(url), false));
    }
  });

  describe("172.16.0.0/12 boundary — exact numeric comparison (m[1] >= 16 && <= 31)", () => {
    it("172.15.255.255 is OUTSIDE the range → accepted", () => {
      assert.equal(isSafeUrl("http://172.15.255.255/"), true);
    });
    it("172.16.0.0 is the START of the range → rejected", () => {
      assert.equal(isSafeUrl("http://172.16.0.0/"), false);
    });
    it("172.31.255.255 is the END of the range → rejected", () => {
      assert.equal(isSafeUrl("http://172.31.255.255/"), false);
    });
    it("172.32.0.0 is OUTSIDE the range → accepted", () => {
      assert.equal(isSafeUrl("http://172.32.0.0/"), true);
    });
    it("172.20.5.5 (mid-range) → rejected", () => {
      assert.equal(isSafeUrl("http://172.20.5.5/"), false);
    });
  });

  describe("0.0.0.0 → rejected", () => {
    it("rejects the unspecified address (routes to localhost on many stacks)", () => {
      assert.equal(isSafeUrl("http://0.0.0.0/"), false);
    });
  });

  describe("IPv4-mapped IPv6 — regression coverage for a real bypass found while writing this suite", () => {
    // The WHATWG URL parser normalizes IPv4-mapped IPv6 literals to the
    // compressed hex form (e.g. "::ffff:127.0.0.1" -> hostname "[::ffff:7f00:1]"),
    // which the plain-hostname string checks never recognized as loopback —
    // an attacker could pass this to reach internal services under the guise
    // of a "safe" URL. Fixed in this session; these cases now reject.
    const cases: Array<[string, string]> = [
      ["http://[::ffff:127.0.0.1]/", "loopback"],
      ["http://[0:0:0:0:0:ffff:127.0.0.1]/", "loopback, fully-expanded input form"],
      ["http://[::ffff:10.0.0.5]/", "10.0.0.0/8"],
      ["http://[::ffff:192.168.1.1]/", "192.168.0.0/16"],
      ["http://[::ffff:169.254.1.1]/", "169.254.0.0/16 link-local"],
      ["http://[::ffff:172.16.0.0]/", "172.16.0.0/12 start boundary"],
      ["http://[::ffff:172.31.255.255]/", "172.16.0.0/12 end boundary"],
      ["http://[::ffff:0.0.0.0]/", "unspecified address"],
    ];
    for (const [url, why] of cases) {
      it(`rejects ${url} (maps to ${why})`, () => assert.equal(isSafeUrl(url), false));
    }

    it("does NOT over-block an IPv4-mapped IPv6 address outside any blocked range", () => {
      assert.equal(isSafeUrl("http://[::ffff:8.8.8.8]/"), true);
    });

    it("does NOT over-block an ordinary global IPv6 address", () => {
      assert.equal(isSafeUrl("http://[2606:4700:4700::1111]/"), true);
    });
  });

  describe("sanity check — a normal public URL is accepted", () => {
    const cases = [
      "https://example.com/",
      "https://example.com:443/path?query=1",
      "http://sub.example.com/a/b/c",
      "https://8.8.8.8/",
    ];
    for (const url of cases) {
      it(`accepts ${url}`, () => assert.equal(isSafeUrl(url), true));
    }
  });

  describe("non-HTTP(S) schemes and malformed input → rejected", () => {
    it("rejects file:// URLs", () => assert.equal(isSafeUrl("file:///etc/passwd"), false));
    it("rejects an unparseable string", () => assert.equal(isSafeUrl("not a url"), false));
  });
});
