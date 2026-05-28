// Full MinIO → DB reconstruction.
//
// MODEL CORRECTION
// ────────────────
// The earlier backfill script treated the DB as source of truth and patched
// keys to match Phase-6B convention. That model fails whenever the DB drifts
// from MinIO — wrong extension, missing thumb row, stale legacy pointer, etc.
//
// This script flips the relationship:
//
//   MinIO defines reality.  DB is a pointer table that we rebuild.
//
// We do not validate, compare, or branch on existing DB values. For every
// mediaId we discover in MinIO, we overwrite the three pointer columns:
//
//   storageKey       = canonical original key   (rebuilt from MinIO)
//   thumbStorageKey  = canonical thumbnail key, or NULL if no thumb in MinIO
//   blurStorageKey   = NULL (architecture removed)
//
// PIPELINE
// ────────
//   Phase 1 — Scan the entire bucket with ListObjectsV2 (paginated). Parse
//             each key into (kind, mediaId, group, ext, date). Index by id.
//   Phase 2 — Per mediaId, derive the canonical Phase-6B keys for original
//             and thumbnail. Date partition is recovered from the object
//             key itself, falling back to the DB row's createdAt for legacy
//             undated flat keys.
//   Phase 3 — (optional, --rewrite-minio) COPY any non-canonical original /
//             thumbnail objects into the canonical layout. HeadObject
//             validates each destination. With --delete-stale, the
//             non-canonical sources are removed *after* the DB pointer is
//             flipped (never before — a crash there would orphan the row).
//   Phase 4 — Hard-overwrite the three pointer columns in `media` for every
//             mediaId found in MinIO. No comparison, no skipping.
//
// SAFETY
// ──────
// • --rewrite-minio uses CopyObjectCommand only; never DeleteObject unless
//   --delete-stale is also passed.
// • --delete-stale requires --rewrite-minio (otherwise we'd delete the
//   exact object the DB still points at via the canonical key).
// • DB updates use updateMany so missing rows return count=0 instead of
//   throwing — surfaced as orphans in the summary.
// • Fully idempotent: re-running converges to the same state.
//
//   Dry run (default, prints planned changes):
//     npm run rebuild:media-from-minio
//   Rewrite DB only (use when MinIO is already canonical):
//     npm run rebuild:media-from-minio -- --apply
//   Rewrite DB and copy MinIO objects into canonical layout:
//     npm run rebuild:media-from-minio -- --apply --rewrite-minio
//   ...plus deletion of non-canonical originals/thumbs/blur objects:
//     npm run rebuild:media-from-minio -- --apply --rewrite-minio --delete-stale
//   Scope to one or more kinds:
//     npm run rebuild:media-from-minio -- --apply --rewrite-minio --kind=images,voice
//
// Run from apps/api so --env-file resolves the repo .env.

import path from "node:path";
import {
  S3Client,
  ListObjectsV2Command,
  CopyObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { PrismaClient } from "@prisma/client";
import { env } from "../backend-core/runtime/env.js";
import { buildVariantKey, type MediaKind as PathKind } from "../modules/media/media.keys.js";

// ── CLI flags ────────────────────────────────────────────────────────────────

const APPLY        = process.argv.includes("--apply");
const REWRITE      = process.argv.includes("--rewrite-minio");
const DELETE_STALE = process.argv.includes("--delete-stale");
const KIND_ARG     = process.argv.find((a) => a.startsWith("--kind="))?.split("=")[1];

if (DELETE_STALE && !REWRITE) {
  console.error("[rebuild] --delete-stale requires --rewrite-minio (we never delete an object that's still the DB pointer)");
  process.exit(1);
}
if ((REWRITE || DELETE_STALE) && !APPLY) {
  console.error("[rebuild] --rewrite-minio / --delete-stale require --apply");
  process.exit(1);
}

const ALL_KINDS: PathKind[] = ["images", "videos", "voice"];

const pathKinds: PathKind[] = (() => {
  if (!KIND_ARG) return ALL_KINDS;
  const result: PathKind[] = [];
  for (const raw of KIND_ARG.toLowerCase().split(",")) {
    const k = raw.trim();
    if (!ALL_KINDS.includes(k as PathKind)) {
      console.error(`[rebuild] unknown kind "${raw}" — valid: images, videos, voice`);
      process.exit(1);
    }
    result.push(k as PathKind);
  }
  return result;
})();

// ── Key classification ──────────────────────────────────────────────────────
// Three historical layouts coexist in the bucket and all three must be
// recognised. We classify each key into one logical group so per-mediaId
// rebuild can pick the right object regardless of which era produced it.

type Group =
  | "original"
  | "thumbnail"
  | "blur"
  | "optimized"
  | "preview"
  | "metadata"
  | "other";

interface ParsedKey {
  key:             string;
  kind:            PathKind;
  id:              string;
  date:            Date | null;  // null = undated flat (pre-Phase-6B)
  group:           Group;
  ext:             string;
  isPhase6BLayout: boolean;      // true = per-mediaId folder layout
}

// Phase-6B per-mediaId folder layout: kind/YYYY/MM/DD/<id>/<group>/<file>
const RE_FOLDER = /^(images|videos|voice)\/(\d{4})\/(\d{2})\/(\d{2})\/([^/]+)\/([a-z]+)\/(.+)$/;
// Dated flat (legacy):                  kind/YYYY/MM/DD/<id>_<variant>.<ext>
// Non-greedy id + alpha variant lets us anchor on the trailing `_<variant>.<ext>`
// suffix even when the id contains dashes (UUIDs) or other allowed chars.
const RE_FLAT_D = /^(images|videos|voice)\/(\d{4})\/(\d{2})\/(\d{2})\/([A-Za-z0-9_-]+?)_([a-z]+)\.([A-Za-z0-9]+)$/;
// Undated flat (oldest):                kind/<id>_<variant>.<ext>
const RE_FLAT_U = /^(images|videos|voice)\/([A-Za-z0-9_-]+?)_([a-z]+)\.([A-Za-z0-9]+)$/;

function classifyFolderGroup(group: string): Group {
  switch (group) {
    case "original":   return "original";
    case "thumbnails": return "thumbnail";
    case "optimized":  return "optimized";
    case "previews":   return "preview";
    case "metadata":   return "metadata";
    default:           return "other";
  }
}

function classifyFlatVariant(v: string): Group {
  switch (v) {
    case "original":  return "original";
    case "thumb":     return "thumbnail";
    case "blur":      return "blur";
    case "optimized": return "optimized";
    case "preview":   return "preview";
    default:          return "other";
  }
}

function parseKey(key: string): ParsedKey | null {
  let m = RE_FOLDER.exec(key);
  if (m) {
    const [, kind, y, mo, d, id, group, filename] = m;
    return {
      key,
      kind:            kind as PathKind,
      id:              id!,
      date:            new Date(Date.UTC(+y!, +mo! - 1, +d!)),
      group:           classifyFolderGroup(group!),
      ext:             path.extname(filename!).toLowerCase(),
      isPhase6BLayout: true,
    };
  }
  m = RE_FLAT_D.exec(key);
  if (m) {
    const [, kind, y, mo, d, id, variant, ext] = m;
    return {
      key,
      kind:            kind as PathKind,
      id:              id!,
      date:            new Date(Date.UTC(+y!, +mo! - 1, +d!)),
      group:           classifyFlatVariant(variant!),
      ext:             "." + ext!.toLowerCase(),
      isPhase6BLayout: false,
    };
  }
  m = RE_FLAT_U.exec(key);
  if (m) {
    const [, kind, id, variant, ext] = m;
    return {
      key,
      kind:            kind as PathKind,
      id:              id!,
      date:            null,
      group:           classifyFlatVariant(variant!),
      ext:             "." + ext!.toLowerCase(),
      isPhase6BLayout: false,
    };
  }
  return null;
}

// ── S3 helpers ───────────────────────────────────────────────────────────────

function makeS3(): S3Client {
  const protocol = env.MINIO_USE_SSL ? "https" : "http";
  return new S3Client({
    endpoint:        `${protocol}://${env.MINIO_ENDPOINT}:${env.MINIO_PORT}`,
    region:          "us-east-1",
    credentials:     { accessKeyId: env.MINIO_ACCESS_KEY, secretAccessKey: env.MINIO_SECRET_KEY },
    forcePathStyle:  true,
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

async function copyObject(s3: S3Client, bucket: string, src: string, dst: string): Promise<void> {
  if (src === dst) return;
  await s3.send(new CopyObjectCommand({
    Bucket:     bucket,
    Key:        dst,
    CopySource: encodeURI(`${bucket}/${src}`),
  }));
  // HeadObject verifies the destination is actually addressable — some S3
  // backends ack copies asynchronously and we don't want to update the DB
  // pointer to a key that 404s on the next request.
  if (!(await objectExists(s3, bucket, dst))) {
    throw new Error(`copy reported success but destination not found: ${dst}`);
  }
}

function defaultExtFor(kind: PathKind): string {
  return kind === "images" ? ".jpg" : kind === "videos" ? ".mp4" : ".opus";
}

function defaultThumbExtFor(kind: PathKind): string {
  // Thumbnails are emitted by sharp; older runs used .jpg, newer .webp.
  // When we have no source thumb at all the canonical thumb won't be written
  // anyway — this only fires for thumbs whose source ext we couldn't recover.
  return kind === "voice" ? ".jpg" : ".webp";
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : "…" + s.slice(s.length - n + 1);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const prisma = new PrismaClient();
  const s3     = makeS3();
  const bucket = env.MINIO_BUCKET;

  const mode =
    !APPLY                  ? "DRY-RUN"               :
    REWRITE && DELETE_STALE ? "APPLY+REWRITE+DELETE"  :
    REWRITE                 ? "APPLY+REWRITE"         :
                              "APPLY (DB-only)";

  // Prominent target banner — the bucket name is the single most important
  // piece of context for a destructive run. Print it first, before any other
  // diagnostic noise, so a misconfigured .env is caught at a glance.
  const endpointHost = `${env.MINIO_USE_SSL ? "https" : "http"}://${env.MINIO_ENDPOINT}:${env.MINIO_PORT}`;
  console.log("");
  console.log("┌─────────────────────────────────────────────────────────────┐");
  console.log("│  MinIO → DB rebuild                                         │");
  console.log("├─────────────────────────────────────────────────────────────┤");
  console.log(`│  bucket:    ${bucket.padEnd(48)}│`);
  console.log(`│  endpoint:  ${endpointHost.padEnd(48)}│`);
  console.log(`│  mode:      ${mode.padEnd(48)}│`);
  console.log(`│  kinds:     ${pathKinds.join(",").padEnd(48)}│`);
  console.log("└─────────────────────────────────────────────────────────────┘");
  console.log("");
  if (APPLY && !REWRITE) {
    console.warn("[rebuild] WARNING: --apply without --rewrite-minio. DB will point at canonical keys");
    console.warn("[rebuild]          regardless of whether MinIO objects live there. Only safe if the");
    console.warn("[rebuild]          bucket is already in Phase-6B layout. Re-run with --rewrite-minio");
    console.warn("[rebuild]          to move objects too.");
  }

  // ── Phase 1: scan MinIO ────────────────────────────────────────────────────
  const mediaMap = new Map<string, { kind: PathKind; keys: ParsedKey[] }>();
  const unrecognized: string[] = [];
  let objectsDiscovered = 0;

  for (const kind of pathKinds) {
    let token: string | undefined;
    do {
      const out = await s3.send(new ListObjectsV2Command({
        Bucket:            bucket,
        Prefix:            `${kind}/`,
        ContinuationToken: token,
      }));
      for (const o of out.Contents ?? []) {
        if (!o.Key) continue;
        objectsDiscovered++;
        const parsed = parseKey(o.Key);
        if (!parsed) { unrecognized.push(o.Key); continue; }
        let entry = mediaMap.get(parsed.id);
        if (!entry) { entry = { kind: parsed.kind, keys: [] }; mediaMap.set(parsed.id, entry); }
        entry.keys.push(parsed);
      }
      token = out.IsTruncated ? out.NextContinuationToken : undefined;
    } while (token);
  }

  console.log(`[rebuild] scan: ${objectsDiscovered} objects → ${mediaMap.size} mediaIds, ${unrecognized.length} unrecognized`);

  // ── DB snapshot (read-only; used for createdAt fallback + missing report) ─
  const dbRows = await prisma.media.findMany({
    select: { id: true, createdAt: true, kind: true },
  });
  const dbById = new Map(dbRows.map((r) => [r.id, r]));

  // ── Phase 2/3/4: per-mediaId rebuild ──────────────────────────────────────
  let updated     = 0;  // DB rows actually overwritten
  let plannedOnly = 0;  // counted in dry-run mode
  let orphans     = 0;  // mediaId present in MinIO, no DB row
  let noOriginal  = 0;  // mediaId has no /original/ object — skipped
  let noDate      = 0;  // undated flat + no DB row — can't pick a partition
  let copyFailed  = 0;

  for (const [mediaId, entry] of mediaMap) {
    const originals = entry.keys.filter((k) => k.group === "original");
    if (originals.length === 0) {
      console.warn(`  NO-ORIGINAL  ${truncate(mediaId, 16)}  kind=${entry.kind}  groups=[${entry.keys.map((k) => k.group).join(",")}]`);
      noOriginal++;
      continue;
    }
    // Prefer Phase-6B layout when both legacy and modern exist — the canonical
    // key we're about to compute will match it byte-for-byte, so the copy is
    // skipped and we converge faster.
    originals.sort((a, b) => Number(b.isPhase6BLayout) - Number(a.isPhase6BLayout));
    const original = originals[0]!;

    const thumbs = entry.keys.filter((k) => k.group === "thumbnail");
    thumbs.sort((a, b) => Number(b.isPhase6BLayout) - Number(a.isPhase6BLayout));
    const thumb = thumbs[0] ?? null;

    const blurs = entry.keys.filter((k) => k.group === "blur");

    // Date partition: prefer the date baked into the original key. For undated
    // flat keys, fall back to the DB row's createdAt — without that, there's
    // no idempotent way to pick a folder, so we skip the row.
    const dbRow = dbById.get(mediaId);
    const date  = original.date ?? dbRow?.createdAt ?? null;
    if (!date) {
      console.warn(`  NO-DATE      ${truncate(mediaId, 16)}  undated flat key + no DB row; cannot derive canonical partition`);
      noDate++;
      continue;
    }

    const canonicalOriginal = buildVariantKey({
      kind:     entry.kind,
      id:       mediaId,
      group:    "original",
      filename: `source${original.ext || defaultExtFor(entry.kind)}`,
      date,
    });

    const canonicalThumb = thumb
      ? buildVariantKey({
          kind:     entry.kind,
          id:       mediaId,
          group:    "thumbnails",
          filename: `thumb_md${thumb.ext || defaultThumbExtFor(entry.kind)}`,
          date,
        })
      : null;

    // ── Plan log ──
    const lines: string[] = [];
    lines.push(`  ${entry.kind.padEnd(6)} ${truncate(mediaId, 16).padEnd(17)} orig:  ${truncate(original.key, 70)}`);
    if (original.key !== canonicalOriginal) lines.push(`${" ".repeat(31)}->     ${truncate(canonicalOriginal, 70)}`);
    if (thumb && canonicalThumb) {
      lines.push(`${" ".repeat(24)} thumb: ${truncate(thumb.key, 70)}`);
      if (thumb.key !== canonicalThumb) lines.push(`${" ".repeat(31)}->     ${truncate(canonicalThumb, 70)}`);
    }
    if (blurs.length > 0) {
      lines.push(`${" ".repeat(24)} blur:  ${blurs.length} object(s) → DB=NULL${DELETE_STALE ? ", MinIO=DELETE" : ""}`);
    }
    console.log(lines.join("\n"));

    if (!APPLY) {
      plannedOnly++;
      continue;
    }

    // ── Phase 3: rewrite MinIO ───────────────────────────────────────────────
    if (REWRITE) {
      try {
        if (original.key !== canonicalOriginal && !(await objectExists(s3, bucket, canonicalOriginal))) {
          await copyObject(s3, bucket, original.key, canonicalOriginal);
        }
        if (thumb && canonicalThumb && thumb.key !== canonicalThumb && !(await objectExists(s3, bucket, canonicalThumb))) {
          await copyObject(s3, bucket, thumb.key, canonicalThumb);
        }
      } catch (err) {
        copyFailed++;
        console.error(`         COPY FAILED for ${mediaId}: ${(err as Error).message}`);
        continue;  // do NOT update DB if copy failed
      }
    }

    // ── Phase 4: hard-overwrite DB pointer ───────────────────────────────────
    // updateMany returns count=0 silently for orphans (mediaId in MinIO but no
    // DB row) — those are reported in the summary, not raised as errors.
    const res = await prisma.media.updateMany({
      where: { id: mediaId },
      data:  {
        storageKey:      canonicalOriginal,
        thumbStorageKey: canonicalThumb,
        blurStorageKey:  null,
        blurWidth:       null,
        blurHeight:      null,
      },
    });
    if (res.count === 0) {
      orphans++;
      console.warn(`         DB ORPHAN: no media row with id=${mediaId}`);
      // No DB row → don't delete stale objects either (we'd lose the only
      // copy of an asset that might still be needed for forensic recovery).
      continue;
    }
    updated++;

    // ── Phase 3b: delete non-canonical objects (post-DB-commit, opt-in) ─────
    if (REWRITE && DELETE_STALE) {
      const toDelete = new Set<string>();
      for (const o of originals) if (o.key !== canonicalOriginal) toDelete.add(o.key);
      for (const t of thumbs)    if (!canonicalThumb || t.key !== canonicalThumb) toDelete.add(t.key);
      for (const b of blurs)     toDelete.add(b.key);

      for (const key of toDelete) {
        try {
          await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
          console.log(`         deleted: ${key}`);
        } catch (err) {
          console.warn(`         delete failed: ${key} — ${(err as Error).message}`);
        }
      }
    }
  }

  // ── Missing: in DB, not in MinIO (constrained to scanned kinds) ──────────
  const scannedKinds = new Set(pathKinds);
  const minioIds     = new Set(mediaMap.keys());
  const missing: string[] = [];
  for (const r of dbRows) {
    if (!r.kind) continue;
    const pk: PathKind = r.kind === "IMAGE" ? "images" : r.kind === "VIDEO" ? "videos" : "voice";
    if (!scannedKinds.has(pk)) continue;
    if (!minioIds.has(r.id)) missing.push(r.id);
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log("\n──────── summary ────────");
  console.log(`bucket:              ${bucket}`);
  console.log(`endpoint:            ${endpointHost}`);
  console.log(`mode:                ${mode}`);
  console.log(`scanned kinds:       ${pathKinds.join(", ")}`);
  console.log(`objects discovered:  ${objectsDiscovered}`);
  console.log(`unrecognized keys:   ${unrecognized.length}`);
  if (unrecognized.length > 0 && unrecognized.length <= 20) {
    for (const u of unrecognized) console.log(`  - ${u}`);
  } else if (unrecognized.length > 20) {
    console.log(`  (showing first 20)`);
    for (const u of unrecognized.slice(0, 20)) console.log(`  - ${u}`);
  }
  console.log(`mediaIds in MinIO:   ${mediaMap.size}`);
  console.log(`db rows updated:     ${APPLY ? updated : `${plannedOnly} (planned, dry-run)`}`);
  console.log(`orphans (MinIO):     ${orphans}    # in MinIO, no DB row — skipped`);
  console.log(`no-original:         ${noOriginal} # mediaId without /original/ — skipped`);
  console.log(`no-date:             ${noDate}    # undated flat + no DB row — skipped`);
  console.log(`copy failed:         ${copyFailed}`);
  console.log(`missing (DB):        ${missing.length}    # in DB, no objects in MinIO`);
  if (missing.length > 0 && missing.length <= 20) {
    for (const m of missing) console.log(`  - ${m}`);
  } else if (missing.length > 20) {
    console.log(`  (showing first 20)`);
    for (const m of missing.slice(0, 20)) console.log(`  - ${m}`);
  }

  if (!APPLY) {
    console.log(`\n[rebuild] DRY-RUN — no writes to bucket=${bucket} or DB. Re-run with --apply (and probably --rewrite-minio).`);
  } else if (!REWRITE) {
    console.log(`\n[rebuild] DB rewritten. Bucket=${bucket} not touched. If non-canonical objects exist, app reads will 404.`);
  } else if (!DELETE_STALE) {
    console.log(`\n[rebuild] WROTE to bucket=${bucket}. Non-canonical objects preserved — re-run with --delete-stale once verified.`);
  } else {
    console.log(`\n[rebuild] WROTE + DELETED in bucket=${bucket}. Cleanup complete.`);
  }

  await prisma.$disconnect();
  if (copyFailed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("[rebuild] fatal:", err);
  process.exit(1);
});
