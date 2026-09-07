import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// Generic reversible encryption for secrets that must be read back in plaintext
// (unlike passwords.ts, which is one-way hashing). Used for third-party OAuth
// tokens (e.g. Spotify) that we must present back to the provider's API.
//
// AES-256-GCM: a random 12-byte IV per call (GCM's authentication breaks down
// if an IV is ever reused under the same key) plus the 16-byte auth tag, both
// stored alongside the ciphertext so decryption is self-contained given only
// the key. Wire format: "<iv-hex>:<authTag-hex>:<ciphertext-hex>".
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;

function keyBuffer(hexKey: string): Buffer {
  const key = Buffer.from(hexKey, "hex");
  if (key.length !== 32) {
    throw new Error(`Encryption key must be 32 bytes (64 hex chars), got ${key.length} bytes`);
  }
  return key;
}

export function encryptSecret(plaintext: string, hexKey: string): string {
  const key = keyBuffer(hexKey);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${authTag.toString("hex")}:${ciphertext.toString("hex")}`;
}

export function decryptSecret(encoded: string, hexKey: string): string {
  const key = keyBuffer(hexKey);
  const parts = encoded.split(":");
  if (parts.length !== 3) {
    throw new Error("Malformed ciphertext: expected \"iv:authTag:ciphertext\"");
  }
  const [ivHex, authTagHex, ciphertextHex] = parts;
  const iv = Buffer.from(ivHex!, "hex");
  const authTag = Buffer.from(authTagHex!, "hex");
  const ciphertext = Buffer.from(ciphertextHex!, "hex");

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
