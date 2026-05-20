import { createHash, randomBytes } from "node:crypto";
import argon2 from "argon2";

// Salt: 32 bytes = 256 bits, stored as 64 hex chars.
export function generateSalt(): string {
  return randomBytes(32).toString("hex");
}

// SHA-256 pre-hash: normalises any password length to a fixed 32-byte hex string
// before feeding to Argon2id. Side-steps the 72-char input ceiling some Argon2
// implementations enforce.
function preHash(salt: string, plaintext: string): string {
  return createHash("sha256").update(salt + plaintext).digest("hex");
}

const ARGON2_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 65536, // 64 MB — OWASP 2024 recommended
  timeCost: 3,
  parallelism: 4,
  hashLength: 32,
};

export async function hashPassword(plaintext: string, salt: string): Promise<string> {
  return argon2.hash(preHash(salt, plaintext), ARGON2_OPTIONS);
}

export async function verifyPassword(
  storedHash: string,
  plaintext: string,
  salt: string,
): Promise<boolean> {
  return argon2.verify(storedHash, preHash(salt, plaintext));
}
