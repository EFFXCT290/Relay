// Enforce Phase-6B storage layout for all media rows (IMAGE, VIDEO, VOICE).
//
// Every row is inspected. Per row the script handles three storage fields:
//
//   storageKey      (original)  — migrate legacy flat/dated-flat → <id>/original/source.*
//   thumbStorageKey (thumbnail) — migrate legacy flat → <id>/thumbnails/thumb_md.*
//   blurStorageKey  (blur)      — dead architecture: null DB field, delete MinIO object
//
// For each field, the script:
//   • Derives the canonical Phase-6B key deterministically from the DB row.
//   • If the object is already at the canonical key → verify it exists in MinIO.
//   • If the object is at a legacy key → COPY to canonical, update DB, optionally delete.
//   • Blur has no canonical target — always nulled out.
//
// The DB is the source of truth — only objects referenced by a row are touched.
// Prod and dev share one MinIO bucket; rows whose source object is absent are
// logged as missing and skipped without failing the run.
//
// S3/MinIO has no rename: every move is COPY → verify → DB update → (DELETE).
// Deletion is opt-in so a crash mid-run can never orphan a row from its object.
//
// Fully idempotent: safe to re-run at any time.
//
//   Dry run (default, no MinIO calls):
//     npm run backfill:media-keys
//   Migrate all fields, leave old objects in place:
//     npm run backfill:media-keys -- --apply
//   Migrate + delete stale objects:
//     npm run backfill:media-keys -- --apply --delete-stale
//   Scope to one or more kinds:
//     npm run backfill:media-keys -- --apply --kind=images
//     npm run backfill:media-keys -- --apply --kind=images,voice
//
// Run from apps/api so --env-file resolves the repo .env.

import path from "node:path";
import {
  S3Client,
  CopyObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { PrismaClient } from "@prisma/client";
import { env } from "../backend-core/runtime/env.js";
import { buildVariantKey, parseMediaPrefix, parseMediaKeyDate, assertPhase6BKey } from "../modules/media/media.keys.js";

const APPLY        = process.argv.includes("--apply");
const DELETE_STALE = process.argv.includes("--delete-stale");

const KIND_ARG = process.argv.find((a) => a.startsWith("--kind="))?.split("=")[1];
const PATH_TO_PRISMA: Record<string, "IMAGE" | "VIDEO" | "VOICE"> = {
  images: "IMAGE", videos: "VIDEO", voice: "VOICE",
};
const kindFilter: Array<"IMAGE" | "VIDEO" | "VOICE"> | null = (() => {
  if (!KIND_ARG) return null;
  const result: Array<"IMAGE" | "VIDEO" | "VOICE"> = [];
  for (const p of KIND_ARG.toLowerCase().split(",")) {
    const k = PATH_TO_PRISMA[p];
    if (!k) { console.error(`[backfill] unknown kind "${p}" — valid: images, videos, voice`); process.exit(1); }
    result.push(k);
  }
  return result;
})();

const KIND_META: Record<"IMAGE" | "VIDEO" | "VOICE", {
  pathKind:   "images" | "videos" | "voice";
  defaultExt: string;
}> = {
  IMAGE: { pathKind: "images", defaultExt: ".jpg"  },
  VIDEO: { pathKind: "videos", defaultExt: ".mp4"  },
  VOICE: { pathKind: "voice",  defaultExt: ".opus" },
};

function makeS3(): S3Client {
  const protocol = env.MINIO_USE_SSL ? "https" : "http";
  return new S3Client({
    endpoint: `${protocol}://${env.MINIO_ENDPOINT}:${env.MINIO_PORT}`,
    region: "us-east-1",
    credentials: { accessKeyId: env.MINIO_ACCESS_KEY, secretAccessKey: env.MINIO_SECRET_KEY },
    forcePathStyle: true,
  });
}

async function objectExists(s3: S3Client, bucket: string, key: string): Promise<boolean> {
  try { await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key })); return true; }
  catch { return false; }
}

async function copyObject(s3: S3Client, bucket: string, src: string, dst: string): Promise<void> {
  await s3.send(new CopyObjectCommand({ Bucket: bucket, Key: dst, CopySource: encodeURI(`${bucket}/${src}`) }));
  if (!await objectExists(s3, bucket, dst)) throw new Error(`copy reported success but destination not found: ${dst}`);
}

async function main() {
  const prisma = new PrismaClient();
  const s3     = makeS3();
  const bucket = env.MINIO_BUCKET;

  const modeStr = !APPLY ? "DRY-RUN" : DELETE_STALE ? "APPLY+DELETE" : "APPLY";
  console.log(`[backfill] mode=${modeStr}  bucket=${bucket}  kind=${kindFilter?.join(",") ?? "all"}`);

  let migrated = 0;
  let skipped  = 0;
  let missing  = 0;
  let failed   = 0;

  const rows = await prisma.media.findMany({
    where:   kindFilter ? { kind: { in: kindFilter } } : undefined,
    select:  { id: true, storageKey: true, createdAt: true, kind: true, thumbStorageKey: true, blurStorageKey: true },
    orderBy: { createdAt: "asc" },
  });

  console.log(`[backfill] ${rows.length} rows to check\n`);

  for (const row of rows) {
    if (!row.kind) { skipped++; continue; }
    const meta = KIND_META[row.kind];

    // ── Derive canonical keys ────────────────────────────────────────────────

    // Original
    const origDate     = parseMediaKeyDate(row.storageKey) ?? row.createdAt;
    const origExt      = path.extname(row.storageKey) || meta.defaultExt;
    const canonOrigKey = buildVariantKey({ kind: meta.pathKind, id: row.id, group: "original", filename: `source${origExt}`, date: origDate });
    assertPhase6BKey(canonOrigKey);
    const origNeedsMigr = row.storageKey !== canonOrigKey;

    // Thumb — only if pointing at a legacy flat key
    const legacyThumbKey = (row.thumbStorageKey && parseMediaPrefix(row.thumbStorageKey) === null)
      ? row.thumbStorageKey : null;
    let canonThumbKey: string | null = null;
    if (legacyThumbKey) {
      const thumbDate = parseMediaKeyDate(legacyThumbKey) ?? row.createdAt;
      const thumbExt  = path.extname(legacyThumbKey) || ".jpg";
      canonThumbKey   = buildVariantKey({ kind: meta.pathKind, id: row.id, group: "thumbnails", filename: `thumb_md${thumbExt}`, date: thumbDate });
      assertPhase6BKey(canonThumbKey);
    }

    // Blur — dead architecture; legacy flat key only (Phase-6B blur keys don't exist)
    const legacyBlurKey = (row.blurStorageKey && parseMediaPrefix(row.blurStorageKey) === null)
      ? row.blurStorageKey : null;
    const hasBlurCleanup = !!(legacyBlurKey || row.blurStorageKey);

    // ── Check if anything needs to change ───────────────────────────────────
    const hasWork = origNeedsMigr || canonThumbKey !== null || hasBlurCleanup;

    if (!hasWork) {
      if (APPLY) {
        // Row appears fully correct — verify the object actually lives at that key.
        if (await objectExists(s3, bucket, row.storageKey)) {
          skipped++;
        } else {
          missing++;
          console.warn(`  MISSING  ${row.kind} ${row.id.slice(0, 8)}  no object at canonical key: ${row.storageKey}`);
        }
      } else {
        skipped++;
      }
      continue;
    }

    // ── Log planned actions ─────────────────────────────────────────────────
    if (origNeedsMigr)   console.log(`  ${row.kind.padEnd(5)} ${row.id.slice(0, 8)}  original:  ${row.storageKey}\n${"".padEnd(24)}->  ${canonOrigKey}`);
    if (canonThumbKey)   console.log(`  ${row.kind.padEnd(5)} ${row.id.slice(0, 8)}  thumb:     ${legacyThumbKey}\n${"".padEnd(24)}->  ${canonThumbKey}`);
    if (hasBlurCleanup)  console.log(`  ${row.kind.padEnd(5)} ${row.id.slice(0, 8)}  blur:      ${row.blurStorageKey} → DELETE`);

    if (!APPLY) { migrated++; continue; }

    // ── Apply ────────────────────────────────────────────────────────────────
    try {
      const dbUpdate: Record<string, unknown> = {};
      const toDelete: string[] = [];

      // Original
      if (origNeedsMigr) {
        if (!await objectExists(s3, bucket, row.storageKey)) {
          console.warn(`         original: source not found in MinIO — skipping row`);
          missing++;
          continue;
        }
        if (await objectExists(s3, bucket, canonOrigKey)) {
          console.log(`         original: destination already exists — skipping copy`);
        } else {
          await copyObject(s3, bucket, row.storageKey, canonOrigKey);
        }
        dbUpdate.storageKey = canonOrigKey;
        if (DELETE_STALE) toDelete.push(row.storageKey);
      }

      // Thumb
      if (canonThumbKey && legacyThumbKey) {
        if (await objectExists(s3, bucket, canonThumbKey)) {
          console.log(`         thumb:    destination already exists — skipping copy`);
          dbUpdate.thumbStorageKey = canonThumbKey;
        } else if (await objectExists(s3, bucket, legacyThumbKey)) {
          await copyObject(s3, bucket, legacyThumbKey, canonThumbKey);
          dbUpdate.thumbStorageKey = canonThumbKey;
        } else {
          console.warn(`         thumb:    source not found — skipping`);
        }
        if (dbUpdate.thumbStorageKey && DELETE_STALE) toDelete.push(legacyThumbKey);
      }

      // Blur — null DB, delete object
      if (hasBlurCleanup) {
        dbUpdate.blurStorageKey = null;
        dbUpdate.blurWidth      = null;
        dbUpdate.blurHeight     = null;
        if (DELETE_STALE && legacyBlurKey && await objectExists(s3, bucket, legacyBlurKey)) {
          toDelete.push(legacyBlurKey);
        }
      }

      // DB update (single write per row)
      if (Object.keys(dbUpdate).length > 0) {
        await prisma.media.update({ where: { id: row.id }, data: dbUpdate });
      }

      // Deletes (after DB is committed — safe to lose the old objects now)
      for (const key of toDelete) {
        await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
        console.log(`         deleted:   ${key}`);
      }

      migrated++;
    } catch (err) {
      failed++;
      console.error(`         FAILED:`, err);
    }
  }

  console.log(
    `\n[backfill] done.  migrated=${migrated}  skipped=${skipped}  missing=${missing}  failed=${failed}  total=${rows.length}`,
  );
  if (!APPLY) {
    console.log("[backfill] DRY-RUN — no changes written. Re-run with --apply to execute.");
  } else if (!DELETE_STALE) {
    console.log("[backfill] Old objects left in MinIO. Re-run with --delete-stale to remove them after verification.");
  }

  await prisma.$disconnect();
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("[backfill] fatal:", err);
  process.exit(1);
});
