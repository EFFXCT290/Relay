// Migrate Phase-1 (flat) and Phase-2 (dated-flat) storage keys to the
// Phase-6B per-mediaId folder layout, for all media kinds (IMAGE, VIDEO, VOICE).
//
// The DB is the source of truth — only objects referenced by a row are touched.
// Prod and dev share one MinIO bucket; rows whose source object is absent in
// MinIO are silently skipped so one environment's run can't break the other.
//
// S3/MinIO has no rename: each object is COPYed to its new key, verified, then
// the DB row is updated. Deletion is a separate opt-in pass so a crash mid-run
// can never orphan a row from its object.
//
// Idempotent: rows already on a Phase-6B key (has <id>/ subfolder) are skipped.
//
//   Dry run (default):
//     npm run backfill:media-keys
//   Copy + DB update, leave old objects in place:
//     npm run backfill:media-keys -- --apply
//   Copy + DB update + delete old objects:
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

// --kind=images,voice,videos  (maps to Prisma enum values)
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

// Storage path segment + fallback ext when the key has no extension.
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
    credentials: {
      accessKeyId:     env.MINIO_ACCESS_KEY,
      secretAccessKey: env.MINIO_SECRET_KEY,
    },
    forcePathStyle: true,
  });
}

async function objectExists(s3: S3Client, bucket: string, key: string): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch {
    return false;
  }
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
    select:  { id: true, storageKey: true, createdAt: true, kind: true },
    orderBy: { createdAt: "asc" },
  });

  console.log(`[backfill] ${rows.length} rows to check\n`);

  for (const row of rows) {
    // Already in Phase-6B folder layout (<id>/ subfolder present) — skip.
    if (parseMediaPrefix(row.storageKey) !== null) {
      skipped++;
      continue;
    }

    if (!row.kind) { skipped++; continue; }
    const meta = KIND_META[row.kind];
    // Derive partition date: Phase-2 dated keys carry it in the path; legacy
    // flat keys fall back to the row's createdAt.
    const partitionDate = parseMediaKeyDate(row.storageKey) ?? row.createdAt;
    const ext    = path.extname(row.storageKey) || meta.defaultExt;
    const newKey = buildVariantKey({
      kind:     meta.pathKind,
      id:       row.id,
      group:    "original",
      filename: `source${ext}`,
      date:     partitionDate,
    });

    assertPhase6BKey(newKey);

    // Guard against accidental self-copy (key generation bug or schema drift).
    if (row.storageKey === newKey) {
      skipped++;
      continue;
    }

    console.log(`  ${row.kind.padEnd(5)} ${row.id.slice(0, 8)}  ${row.storageKey}`);
    console.log(`         ->  ${newKey}`);

    if (!APPLY) {
      migrated++;
      continue;
    }

    try {
      // Shared-bucket safety: if the source object isn't in MinIO, this row
      // belongs to a different DB environment (prod vs dev) — skip silently.
      if (!await objectExists(s3, bucket, row.storageKey)) {
        console.warn(`         SKIP — not found in MinIO`);
        missing++;
        continue;
      }

      // Skip the copy if the destination already exists — makes retries safe.
      if (await objectExists(s3, bucket, newKey)) {
        console.log(`         destination already exists — skipping copy`);
      } else {
        await s3.send(new CopyObjectCommand({
          Bucket:     bucket,
          Key:        newKey,
          CopySource: encodeURI(`${bucket}/${row.storageKey}`),
        }));

        // Verify the destination landed before touching the DB.
        if (!await objectExists(s3, bucket, newKey)) {
          throw new Error(`copy reported success but destination not found: ${newKey}`);
        }
      }

      // Update DB: point storageKey at the new Phase-6B key.
      // blurStorageKey is dead architecture — null it out unconditionally.
      await prisma.media.update({
        where: { id: row.id },
        data:  {
          storageKey:     newKey,
          blurStorageKey: null,
          blurWidth:      null,
          blurHeight:     null,
        },
      });

      if (DELETE_STALE) {
        await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: row.storageKey }));
        console.log(`         deleted old object`);
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
    console.log("[backfill] Old objects left in MinIO. Re-run with --delete-stale to garbage-collect after you have verified the migration.");
  }

  await prisma.$disconnect();
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("[backfill] fatal:", err);
  process.exit(1);
});
