import { randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import type { Redis } from "ioredis";
import { env } from "../runtime/env.js";
import type { JwtPayload } from "@relay/contracts";

type SignResult = { token: string; jti: string; expiresAt: Date };

function sign(
  userId: string,
  secret: string,
  ttlSeconds: number,
): SignResult {
  const jti = randomUUID();
  const token = jwt.sign({ sub: userId, jti }, secret, {
    algorithm: "HS256",
    expiresIn: ttlSeconds,
  });
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
  return { token, jti, expiresAt };
}

export function signAccessToken(userId: string): SignResult {
  return sign(userId, env.JWT_SECRET, env.JWT_ACCESS_EXPIRY);
}

export function signRefreshToken(userId: string): SignResult {
  return sign(userId, env.JWT_REFRESH_SECRET, env.JWT_REFRESH_EXPIRY);
}

export function verifyAccessToken(token: string): JwtPayload {
  return jwt.verify(token, env.JWT_SECRET, { algorithms: ["HS256"] }) as JwtPayload;
}

export function verifyRefreshToken(token: string): JwtPayload {
  return jwt.verify(token, env.JWT_REFRESH_SECRET, { algorithms: ["HS256"] }) as JwtPayload;
}

const blocklistKey = (jti: string) => `jti:${jti}`;

export async function isBlocklisted(redis: Redis, jti: string): Promise<boolean> {
  return (await redis.exists(blocklistKey(jti))) === 1;
}

// Add a jti to the blocklist with a TTL equal to the token's remaining lifetime
// (in seconds). Past the TTL Redis evicts the key — the token would be expired
// by then anyway, so no need to keep paying for storage.
export async function blocklistJti(
  redis: Redis,
  jti: string,
  expiresAt: Date,
): Promise<void> {
  const ttlSeconds = Math.max(1, Math.ceil((expiresAt.getTime() - Date.now()) / 1000));
  await redis.set(blocklistKey(jti), "1", "EX", ttlSeconds);
}
