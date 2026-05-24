// One-time backfill: relocate legacy flat media keys (images/<uuid>.jpg) into
// the dated layout (images/YYYY/MM/DD/<id>_original.jpg) using each row's
// createdAt for the partition.
//
// S3/MinIO has no rename, so each object is COPIED to its new key, the DB row's
// storageKey is updated, then the old object is DELETED. The order matters:
// copy + DB update happen first, so a crash mid-run never orphans a row from
// its object — at worst an old object lingers and gets swept on re-run.
//
// Idempotent: rows already on a dated key are skipped, so it's safe to re-run.
//
//   Dry run (default, no writes):
//     npm run backfill:media-keys
//   Execute:
//     npm run backfill:media-keys -- --apply
//
// Run from apps/api so --env-file resolves the repo .env.

import path from "node:path";
import {
  S3Client,
  CopyObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { PrismaClient } from "@prisma/client";
import { env } from "../backend-core/runtime/env.js";
import { buildMediaKey } from "../modules/media/media.keys.js";

const APPLY = process.argv.includes("--apply");

// A key is already in the new layout if it starts with images/YYYY/MM/DD/.
const DATED_KEY = /^images\/\d{4}\/\d{2}\/\d{2}\//;

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

async function main() {
  const prisma = new PrismaClient();
  const s3     = makeS3();
  const bucket = env.MINIO_BUCKET;

  let migrated = 0;
  let skipped  = 0;
  let failed   = 0;

  console.log(`[backfill] mode=${APPLY ? "APPLY" : "DRY-RUN"} bucket=${bucket}`);

  const rows = await prisma.media.findMany({
    select: { id: true, storageKey: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });

  for (const row of rows) {
    if (DATED_KEY.test(row.storageKey)) {
      skipped++;
      continue;
    }

    const ext    = path.extname(row.storageKey) || ".jpg";
    const newKey = buildMediaKey({
      kind:    "images",
      id:      row.id,
      variant: "original",
      ext,
      date:    row.createdAt,
    });

    console.log(`[backfill] ${row.storageKey}  ->  ${newKey}`);

    if (!APPLY) {
      migrated++;
      continue;
    }

    try {
      // CopySource is the URL-encoded "bucket/key" path; the leading segment
      // must survive special characters in the key.
      await s3.send(new CopyObjectCommand({
        Bucket:     bucket,
        Key:        newKey,
        CopySource: encodeURI(`${bucket}/${row.storageKey}`),
      }));

      await prisma.media.update({
        where: { id: row.id },
        data:  { storageKey: newKey },
      });

      await s3.send(new DeleteObjectCommand({
        Bucket: bucket,
        Key:    row.storageKey,
      }));

      migrated++;
    } catch (err) {
      failed++;
      console.error(`[backfill] FAILED ${row.id}:`, err);
    }
  }

  console.log(
    `[backfill] done. migrated=${migrated} skipped=${skipped} failed=${failed} total=${rows.length}`,
  );
  if (!APPLY) console.log("[backfill] DRY-RUN — no changes written. Re-run with --apply to execute.");

  await prisma.$disconnect();
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("[backfill] fatal:", err);
  process.exit(1);
});
