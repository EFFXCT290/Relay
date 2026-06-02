// Avatar processing + storage.
//
// Avatars are deliberately NOT Media rows: they're a single, constrained image
// per user (one per account, square, small). So they bypass the async media
// worker and the Phase-6B key tree entirely — resize is synchronous (one input,
// one output, a few KB) and keys live in their own `avatars/` namespace. The raw
// MinIO key is stored on User.avatarKey; signed URLs are minted at read time.
import { randomBytes } from "node:crypto";
import sharp from "sharp";
import { PutObjectCommand, DeleteObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import type { PrismaClient } from "@prisma/client";
import { env } from "../../backend-core/runtime/env.js";

// Accept only what the browser's canvas re-encoder emits — it normalizes any
// source (including iOS HEIC) to one of these before upload. Keeping HEIC out
// here avoids a hard libheif dependency in the request path.
const ALLOWED_AVATAR_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);

// Pre-resize guard. The client already downscales, so anything bigger is junk or
// abuse — reject before handing a large buffer to sharp.
const MAX_AVATAR_BYTES = 10 * 1024 * 1024;

// One square display size. 256 covers every render site (≤96px, even at 2× DPR)
// while staying a few KB as webp. Chat avatars never need more than one size.
const AVATAR_SIZE = 256;

export class AvatarTooLargeError extends Error {
  readonly code = "too_large" as const;
}
export class AvatarBadFormatError extends Error {
  readonly code = "bad_format" as const;
}

export function isAllowedAvatarMime(mimeType: string): boolean {
  return ALLOWED_AVATAR_MIME.has(mimeType.split(";")[0]!.trim().toLowerCase());
}

/** `avatars/{userId}/{rand}.webp` — own namespace, outside the Media key tree.
 *  The random token makes every replacement a fresh key, so a CDN/browser that
 *  cached the previous avatar never serves it after an update. */
function buildAvatarKey(userId: string): string {
  return `avatars/${userId}/${randomBytes(8).toString("hex")}.webp`;
}

/** Normalize an uploaded image to a square 256×256 webp. .rotate() applies EXIF
 *  orientation first (must precede resize); fit:"cover" center-crops so a
 *  non-square source still yields a clean circle — a server-side backstop for
 *  the client crop. */
export async function processAvatar(buffer: Buffer): Promise<Buffer> {
  return sharp(buffer)
    .rotate()
    .resize(AVATAR_SIZE, AVATAR_SIZE, { fit: "cover", position: "centre" })
    .webp({ quality: 80 })
    .toBuffer();
}

/**
 * Replace a user's avatar: validate → resize → upload under a fresh key → point
 * the row at it → delete the previous object best-effort. Returns the new key.
 *
 * Order matters: the new object is written and the row updated before the old
 * object is removed, so a crash mid-flight never leaves the row pointing at a
 * deleted key. Old-object cleanup failures are swallowed — a stray orphan is
 * harmless (the gc:orphan sweep is the backstop) and must not fail the update.
 */
export async function putAvatar(opts: {
  userId:   string;
  buffer:   Buffer;
  mimeType: string;
  prisma:   PrismaClient;
  s3:       S3Client;
}): Promise<string> {
  const { userId, buffer, mimeType, prisma, s3 } = opts;

  if (!isAllowedAvatarMime(mimeType)) {
    throw new AvatarBadFormatError("Unsupported image format. Use JPEG, PNG, or WEBP.");
  }
  if (buffer.length > MAX_AVATAR_BYTES) {
    throw new AvatarTooLargeError("Image too large.");
  }

  let webp: Buffer;
  try {
    webp = await processAvatar(buffer);
  } catch {
    throw new AvatarBadFormatError("Could not read that image.");
  }

  const prev = await prisma.user.findUnique({ where: { id: userId }, select: { avatarKey: true } });
  const key  = buildAvatarKey(userId);

  await s3.send(new PutObjectCommand({
    Bucket:        env.MINIO_BUCKET,
    Key:           key,
    Body:          webp,
    ContentType:   "image/webp",
    ContentLength: webp.length,
  }));

  await prisma.user.update({ where: { id: userId }, data: { avatarKey: key } });

  if (prev?.avatarKey && prev.avatarKey !== key) {
    await deleteObjectQuietly(s3, prev.avatarKey);
  }
  return key;
}

/** Remove a user's avatar. Nulls the row first, then deletes the object
 *  best-effort. Returns the removed key, or null if there was none. */
export async function clearAvatar(opts: {
  userId: string;
  prisma: PrismaClient;
  s3:     S3Client;
}): Promise<string | null> {
  const { userId, prisma, s3 } = opts;
  const prev = await prisma.user.findUnique({ where: { id: userId }, select: { avatarKey: true } });
  if (!prev?.avatarKey) return null;

  await prisma.user.update({ where: { id: userId }, data: { avatarKey: null } });
  await deleteObjectQuietly(s3, prev.avatarKey);
  return prev.avatarKey;
}

async function deleteObjectQuietly(s3: S3Client, key: string): Promise<void> {
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: env.MINIO_BUCKET, Key: key }));
  } catch {
    /* orphan cleanup is best-effort; the gc:orphan sweep is the backstop */
  }
}
