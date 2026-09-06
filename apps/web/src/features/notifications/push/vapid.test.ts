import { describe, it, expect } from "vitest";
import { urlBase64ToUint8Array } from "./vapid";

// Known-correct base64url/byte-array pairs, computed independently (Python's
// stdlib base64.urlsafe_b64encode), NOT by round-tripping this function's own
// encode/decode against itself — round-tripping only proves internal
// self-consistency, not correctness against the actual base64url spec this
// feeds into PushManager.subscribe()'s applicationServerKey.

describe("urlBase64ToUint8Array() — exact byte correctness against known vectors", () => {
  it('"SGVsbG8sIHdvcmxkIQ" decodes to the exact bytes of "Hello, world!"', () => {
    const result = urlBase64ToUint8Array("SGVsbG8sIHdvcmxkIQ");
    const expected = Array.from(new TextEncoder().encode("Hello, world!"));
    expect(Array.from(result)).toEqual(expected);
  });

  it("decodes a real 65-byte uncompressed P-256 VAPID public key to its exact bytes", () => {
    // This is the actual disposable VAPID key committed in apps/api/.env.test
    // (generated via web-push's own generateVAPIDKeys()) — an authentic,
    // spec-shaped example, not a synthetic string.
    const key = "BJoqKvv0cPZb3Q5B_emFExqqab-tDkqqi0gOHQ_4ZHq9p69PpOasgOxybdwEO2vNkSZedOrnJXnlUdnIOTh0AAY";
    const result = urlBase64ToUint8Array(key);

    expect(result.length).toBe(65);
    expect(result[0]).toBe(0x04); // uncompressed EC point marker — confirms byte 0 isn't off-by-one
    const expected = [
      4, 154, 42, 42, 251, 244, 112, 246, 91, 221, 14, 65, 253, 233, 133, 19, 26, 170, 105, 191, 173, 14, 74, 170,
      139, 72, 14, 29, 15, 248, 100, 122, 189, 167, 175, 79, 164, 230, 172, 128, 236, 114, 109, 220, 4, 59, 107, 205,
      145, 38, 94, 116, 234, 231, 37, 121, 229, 81, 217, 200, 57, 56, 116, 0, 6,
    ];
    expect(Array.from(result)).toEqual(expected);
  });

  it("handles every padding-length case correctly (1, 2, and 3-byte inputs need 2, 1, and 0 '=' respectively)", () => {
    expect(Array.from(urlBase64ToUint8Array("_w"))).toEqual([0xff]);
    expect(Array.from(urlBase64ToUint8Array("__4"))).toEqual([0xff, 0xfe]);
    expect(Array.from(urlBase64ToUint8Array("__79"))).toEqual([0xff, 0xfe, 0xfd]);
  });

  it("correctly substitutes the base64url-specific characters ('-' -> '+', '_' -> '/') rather than treating them as literal base64 alphabet", () => {
    // This exact input contains both '-' and '_' — a implementation that
    // forgot the substitution (or swapped which maps to which) would
    // silently produce the wrong bytes here without throwing.
    const result = urlBase64ToUint8Array("Pj_77w");
    expect(Array.from(result)).toEqual([0x3e, 0x3f, 0xfb, 0xef]);
  });

  it("the output is a Uint8Array backed by a real ArrayBuffer (what PushManager.subscribe's applicationServerKey requires)", () => {
    const result = urlBase64ToUint8Array("_w");
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result.buffer).toBeInstanceOf(ArrayBuffer);
  });
});
