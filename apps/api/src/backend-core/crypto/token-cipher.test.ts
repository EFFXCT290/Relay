import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { decryptSecret, encryptSecret } from "./token-cipher.js";

const KEY = randomBytes(32).toString("hex");

describe("encryptSecret()/decryptSecret() — AES-256-GCM round trip", () => {
  it("decrypts back to the exact original plaintext", () => {
    const plaintext = "BQC7x9...a-real-looking-spotify-access-token";
    const encoded = encryptSecret(plaintext, KEY);
    assert.equal(decryptSecret(encoded, KEY), plaintext);
  });

  it("round-trips empty strings and unicode", () => {
    assert.equal(decryptSecret(encryptSecret("", KEY), KEY), "");
    const unicode = "🎧 token with ünïcode — and colons: a:b:c";
    assert.equal(decryptSecret(encryptSecret(unicode, KEY), KEY), unicode);
  });

  it("produces a different ciphertext each time (random IV) even for the same plaintext", () => {
    const a = encryptSecret("same-plaintext", KEY);
    const b = encryptSecret("same-plaintext", KEY);
    assert.notEqual(a, b, "IV must be fresh per call, so ciphertext must differ");
    assert.equal(decryptSecret(a, KEY), "same-plaintext");
    assert.equal(decryptSecret(b, KEY), "same-plaintext");
  });

  it("wire format is iv:authTag:ciphertext, all hex", () => {
    const encoded = encryptSecret("hello", KEY);
    const parts = encoded.split(":");
    assert.equal(parts.length, 3);
    for (const part of parts) assert.match(part, /^[0-9a-f]+$/);
    assert.equal(parts[0]!.length, 24); // 12-byte IV → 24 hex chars
    assert.equal(parts[1]!.length, 32); // 16-byte auth tag → 32 hex chars
  });

  it("rejects a key that isn't exactly 32 bytes", () => {
    assert.throws(() => encryptSecret("x", "deadbeef"), /32 bytes/);
  });

  it("fails closed on tampered ciphertext (GCM auth tag mismatch)", () => {
    const encoded = encryptSecret("secret-value", KEY);
    const [iv, authTag, ciphertext] = encoded.split(":");
    const flippedByte = (ciphertext![0] === "0" ? "1" : "0") + ciphertext!.slice(1);
    const tampered = `${iv}:${authTag}:${flippedByte}`;
    assert.throws(() => decryptSecret(tampered, KEY));
  });

  it("fails closed when decrypted with the wrong key", () => {
    const encoded = encryptSecret("secret-value", KEY);
    const wrongKey = randomBytes(32).toString("hex");
    assert.throws(() => decryptSecret(encoded, wrongKey));
  });
});
