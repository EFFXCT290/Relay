// Orphan media garbage collector.
//
// PURPOSE
// ───────
// After a rebuild-from-minio run, the bucket typically contains leftover
// non-canonical objects (old flat `_original.jpg`, `_blur.jpg`, `_thumb.jpg`)
// and sometimes truly abandoned mediaIds whose DB row was deleted. The
// `--delete-stale` flag on the rebuild script handles the first case for the
// specific mediaIds it processes. This script handles everything else:
//
//   • Objects whose mediaId is not in the DB at all                      (ORPHAN_ID)
//   • Objects under a known mediaId but not referenced and not a known
//     derivative (e.g. leftover legacy `_blur.jpg`, stale flat `_thumb.jpg`)  (ORPHAN_DERIV)
//   • Objects matching a current DB pointer                              (REFERENCED)
//   • Objects under a known mediaId in a recognized variant group        (SIBLING)
//   • Objects that don't parse against any layout                        (UNRECOGNIZED)
//
// Default-deletable categories are ORPHAN_ID and ORPHAN_DERIV. REFERENCED and
// SIBLING are never deleted. UNRECOGNIZED requires explicit opt-in because
// these may be temp uploads or unrelated system objects.
//
// PIPELINE
// ────────
//   Phase 1 — Scan the bucket (ListObjectsV2, paginated). Record key + size +
//             lastModified per object.
//   Phase 2 — Load every DB media row (id, storageKey, thumbStorageKey,
//             blurStorageKey). Build:
//               • dbIds          — set of known mediaIds
//               • pointerKeys    — set of every DB pointer key (active reference)
//   Phase 3 — Classify each scanned object into one of five categories.
//   Phase 4 — Write JSON + CSV safety report to --report-dir.
//   Phase 5 — Print summary with counts + total reclaimable bytes per category.
//   Phase 6 — If --apply, prompt for "DELETE" confirmation (unless --yes),
//             then delete objects in the selected categories.
//
// SAFETY
// ──────
// • Read-only by default. --apply is the only path that touches the bucket.
// • Pointer keys are read fresh in this run — no stale snapshot. If a
//   rebuild is in progress, run GC after it completes (the classification
//   would otherwise treat newly-canonical keys as ORPHAN_DERIV).
// • Confirmation prompt blocks unless --yes is passed.
// • Reports always written before any deletion, even with --yes, so there's
//   a forensic record of what was removed.
// • Multiple report formats: JSON for tooling, CSV for spreadsheet review.
//
//   Inspect only:
//     npm run gc:orphan-media
//   Delete default categories (ORPHAN_ID + ORPHAN_DERIV) with prompt:
//     npm run gc:orphan-media -- --apply
//   Delete without prompt (automation):
//     npm run gc:orphan-media -- --apply --yes
//   Custom categories:
//     npm run gc:orphan-media -- --apply --categories=ORPHAN_ID
//     npm run gc:orphan-media -- --apply --categories=ORPHAN_ID,ORPHAN_DERIV,UNRECOGNIZED
//   Custom report directory:
//     npm run gc:orphan-media -- --report-dir=./gc-reports
//   Scope to one kind:
//     npm run gc:orphan-media -- --kind=images
//
// Run from apps/api so --env-file resolves the repo .env.

import path from "node:path";
import fs from "node:fs";
import readline from "node:readline";
import {
  S3Client,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  type _Object as S3Object,
} from "@aws-sdk/client-s3";
import { PrismaClient } from "@prisma/client";
import { env } from "../backend-core/runtime/env.js";
import { type MediaKind as PathKind } from "../modules/media/media.keys.js";

// ── CLI flags ────────────────────────────────────────────────────────────────

const APPLY    = process.argv.includes("--apply");
const SKIP_PROMPT = process.argv.includes("--yes") || process.argv.includes("-y");
const KIND_ARG    = process.argv.find((a) => a.startsWith("--kind="))?.split("=")[1];
const CATS_ARG    = process.argv.find((a) => a.startsWith("--categories="))?.split("=")[1];
const REPORT_DIR  = process.argv.find((a) => a.startsWith("--report-dir="))?.split("=")[1] ?? "./gc-reports";

const ALL_KINDS: PathKind[] = ["images", "videos", "voice"];

const pathKinds: PathKind[] = (() => {
  if (!KIND_ARG) return ALL_KINDS;
  const result: PathKind[] = [];
  for (const raw of KIND_ARG.toLowerCase().split(",")) {
    const k = raw.trim();
    if (!ALL_KINDS.includes(k as PathKind)) {
      console.error(`[gc] unknown kind "${raw}" — valid: images, videos, voice`);
      process.exit(1);
    }
    result.push(k as PathKind);
  }
  return result;
})();

type Category =
  | "REFERENCED"      // matches a DB pointer key exactly
  | "SIBLING"         // under a DB-known mediaId, in a recognized variant group
  | "ORPHAN_ID"       // mediaId not in DB at all
  | "ORPHAN_DERIV"    // mediaId in DB, but this object isn't a pointer or sibling
  | "UNRECOGNIZED";   // didn't parse against any layout

const ALL_CATEGORIES: Category[] = ["REFERENCED", "SIBLING", "ORPHAN_ID", "ORPHAN_DERIV", "UNRECOGNIZED"];
const DEFAULT_DELETABLE: Category[] = ["ORPHAN_ID", "ORPHAN_DERIV"];
// Hard guardrails — categories that --categories may never include even if
// passed. Deleting referenced or sibling objects breaks live media reads.
const NEVER_DELETE: Set<Category> = new Set(["REFERENCED", "SIBLING"]);

const deleteCategories: Set<Category> = (() => {
  if (!CATS_ARG) return new Set(DEFAULT_DELETABLE);
  const set = new Set<Category>();
  for (const raw of CATS_ARG.toUpperCase().split(",")) {
    const c = raw.trim() as Category;
    if (!ALL_CATEGORIES.includes(c)) {
      console.error(`[gc] unknown category "${raw}" — valid: ${ALL_CATEGORIES.join(",")}`);
      process.exit(1);
    }
    if (NEVER_DELETE.has(c)) {
      console.error(`[gc] refusing to delete category ${c} — these are live references`);
      process.exit(1);
    }
    set.add(c);
  }
  return set;
})();

// ── Key parsing (mirrors rebuild-media-from-minio.ts) ────────────────────────

type Group =
  | "original"
  | "thumbnail"
  | "blur"
  | "optimized"
  | "preview"
  | "metadata"
  | "waveform"
  | "transcript"
  | "other";

const KNOWN_DERIV_GROUPS: Set<Group> = new Set([
  "original", "thumbnail", "optimized", "preview", "metadata", "waveform", "transcript",
]);

interface ParsedKey {
  kind:            PathKind;
  id:              string;
  group:           Group;
  isPhase6BLayout: boolean;
}

const RE_FOLDER = /^(images|videos|voice)\/(\d{4})\/(\d{2})\/(\d{2})\/([^/]+)\/([a-z]+)\/(.+)$/;
const RE_FLAT_D = /^(images|videos|voice)\/(\d{4})\/(\d{2})\/(\d{2})\/([A-Za-z0-9_-]+?)_([a-z]+)\.([A-Za-z0-9]+)$/;
const RE_FLAT_U = /^(images|videos|voice)\/([A-Za-z0-9_-]+?)_([a-z]+)\.([A-Za-z0-9]+)$/;

function classifyFolderGroup(group: string): Group {
  switch (group) {
    case "original":    return "original";
    case "thumbnails":  return "thumbnail";
    case "optimized":   return "optimized";
    case "previews":    return "preview";
    case "metadata":    return "metadata";
    case "waveforms":   return "waveform";
    case "transcripts": return "transcript";
    default:            return "other";
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
    return {
      kind:            m[1] as PathKind,
      id:              m[5]!,
      group:           classifyFolderGroup(m[6]!),
      isPhase6BLayout: true,
    };
  }
  m = RE_FLAT_D.exec(key);
  if (m) {
    return {
      kind:            m[1] as PathKind,
      id:              m[5]!,
      group:           classifyFlatVariant(m[6]!),
      isPhase6BLayout: false,
    };
  }
  m = RE_FLAT_U.exec(key);
  if (m) {
    return {
      kind:            m[1] as PathKind,
      id:              m[2]!,
      group:           classifyFlatVariant(m[3]!),
      isPhase6BLayout: false,
    };
  }
  return null;
}

// ── S3 helpers ───────────────────────────────────────────────────────────────

function makeS3(): S3Client {
  const protocol = env.MINIO_USE_SSL ? "https" : "http";
  return new S3Client({
    endpoint:       `${protocol}://${env.MINIO_ENDPOINT}:${env.MINIO_PORT}`,
    region:         "us-east-1",
    credentials:    { accessKeyId: env.MINIO_ACCESS_KEY, secretAccessKey: env.MINIO_SECRET_KEY },
    forcePathStyle: true,
  });
}

async function listAll(s3: S3Client, bucket: string, prefix: string): Promise<S3Object[]> {
  const out: S3Object[] = [];
  let token: string | undefined;
  do {
    const res = await s3.send(new ListObjectsV2Command({
      Bucket:            bucket,
      Prefix:            prefix,
      ContinuationToken: token,
    }));
    for (const o of res.Contents ?? []) out.push(o);
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return out;
}

// DeleteObjects has a hard limit of 1000 keys per request.
async function deleteBatch(s3: S3Client, bucket: string, keys: string[]): Promise<{ deleted: number; errors: { key: string; message: string }[] }> {
  let deleted = 0;
  const errors: { key: string; message: string }[] = [];
  for (let i = 0; i < keys.length; i += 1000) {
    const chunk = keys.slice(i, i + 1000);
    const res = await s3.send(new DeleteObjectsCommand({
      Bucket: bucket,
      Delete: { Objects: chunk.map((Key) => ({ Key })), Quiet: false },
    }));
    deleted += (res.Deleted?.length ?? 0);
    for (const e of res.Errors ?? []) {
      errors.push({ key: e.Key ?? "(unknown)", message: e.Message ?? e.Code ?? "(no error message)" });
    }
  }
  return { deleted, errors };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function humanBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  const units = ["KB", "MB", "GB", "TB"];
  let i = -1, v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(2)}${units[i]}`;
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function csvEscape(s: string): string {
  if (s.includes(",") || s.includes("\"") || s.includes("\n")) {
    return `"${s.replace(/"/g, "\"\"")}"`;
  }
  return s;
}

async function promptConfirm(question: string, expectedAnswer: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim() === expectedAnswer);
    });
  });
}

// ── Main ─────────────────────────────────────────────────────────────────────

interface ScannedObject {
  key:          string;
  size:         number;
  lastModified: Date | null;
  parsed:       ParsedKey | null;
  category:     Category;
}

async function main() {
  const prisma = new PrismaClient();
  const s3     = makeS3();
  const bucket = env.MINIO_BUCKET;
  const endpointHost = `${env.MINIO_USE_SSL ? "https" : "http"}://${env.MINIO_ENDPOINT}:${env.MINIO_PORT}`;
  const startedAt = new Date();

  const mode = !APPLY ? "REPORT-ONLY" : SKIP_PROMPT ? "APPLY (--yes)" : "APPLY (interactive)";

  console.log("");
  console.log("┌─────────────────────────────────────────────────────────────┐");
  console.log("│  MinIO orphan garbage collector                             │");
  console.log("├─────────────────────────────────────────────────────────────┤");
  console.log(`│  bucket:    ${bucket.padEnd(48)}│`);
  console.log(`│  endpoint:  ${endpointHost.padEnd(48)}│`);
  console.log(`│  mode:      ${mode.padEnd(48)}│`);
  console.log(`│  kinds:     ${pathKinds.join(",").padEnd(48)}│`);
  console.log(`│  delete:    ${[...deleteCategories].join(",").padEnd(48)}│`);
  console.log(`│  report:    ${REPORT_DIR.padEnd(48)}│`);
  console.log("└─────────────────────────────────────────────────────────────┘");
  console.log("");

  // ── Phase 1: scan MinIO ────────────────────────────────────────────────────
  console.log(`[gc] scanning bucket=${bucket}…`);
  const all: S3Object[] = [];
  for (const kind of pathKinds) {
    const objs = await listAll(s3, bucket, `${kind}/`);
    all.push(...objs);
  }
  console.log(`[gc] scan: ${all.length} objects`);

  // ── Phase 2: load DB ───────────────────────────────────────────────────────
  console.log(`[gc] loading DB pointers…`);
  const dbRows = await prisma.media.findMany({
    select: { id: true, storageKey: true, thumbStorageKey: true, blurStorageKey: true },
  });
  const dbIds = new Set(dbRows.map((r) => r.id));
  const pointerKeys = new Set<string>();
  for (const r of dbRows) {
    if (r.storageKey)      pointerKeys.add(r.storageKey);
    if (r.thumbStorageKey) pointerKeys.add(r.thumbStorageKey);
    if (r.blurStorageKey)  pointerKeys.add(r.blurStorageKey);
  }
  console.log(`[gc] db:  ${dbRows.length} rows, ${pointerKeys.size} pointer keys`);

  // ── Phase 3: classify ──────────────────────────────────────────────────────
  const objects: ScannedObject[] = [];
  for (const o of all) {
    if (!o.Key) continue;
    const parsed = parseKey(o.Key);

    let category: Category;
    if (pointerKeys.has(o.Key)) {
      category = "REFERENCED";
    } else if (!parsed) {
      category = "UNRECOGNIZED";
    } else if (!dbIds.has(parsed.id)) {
      category = "ORPHAN_ID";
    } else if (parsed.isPhase6BLayout && KNOWN_DERIV_GROUPS.has(parsed.group)) {
      // Under a known mediaId, in a canonical derivative group → sibling of a
      // live row. Even if not in the pointer set (variants live elsewhere),
      // these are addressable via the manifest and must be preserved.
      category = "SIBLING";
    } else {
      // Known mediaId but legacy flat layout, or a recognized group in a
      // non-canonical position — leftover from before the rebuild moved the
      // pointer to a different key.
      category = "ORPHAN_DERIV";
    }

    objects.push({
      key:          o.Key,
      size:         o.Size ?? 0,
      lastModified: o.LastModified ?? null,
      parsed,
      category,
    });
  }

  // ── Phase 4: write reports ─────────────────────────────────────────────────
  ensureDir(REPORT_DIR);
  const stamp     = startedAt.toISOString().replace(/[:.]/g, "-");
  const jsonPath  = path.join(REPORT_DIR, `gc-orphan-media-${stamp}.json`);
  const csvPath   = path.join(REPORT_DIR, `gc-orphan-media-${stamp}.csv`);

  // Per-category aggregates
  type Agg = { count: number; bytes: number };
  const perCat: Record<Category, Agg> = {
    REFERENCED:    { count: 0, bytes: 0 },
    SIBLING:       { count: 0, bytes: 0 },
    ORPHAN_ID:     { count: 0, bytes: 0 },
    ORPHAN_DERIV:  { count: 0, bytes: 0 },
    UNRECOGNIZED:  { count: 0, bytes: 0 },
  };
  for (const o of objects) {
    perCat[o.category].count++;
    perCat[o.category].bytes += o.size;
  }

  fs.writeFileSync(jsonPath, JSON.stringify({
    meta: {
      generatedAt:  startedAt.toISOString(),
      bucket,
      endpoint:     endpointHost,
      kinds:        pathKinds,
      dbRowCount:   dbRows.length,
      objectCount:  all.length,
      mode,
      deleteCategories: [...deleteCategories],
    },
    summary: perCat,
    objects: objects.map((o) => ({
      key:          o.key,
      category:     o.category,
      size:         o.size,
      lastModified: o.lastModified?.toISOString() ?? null,
      kind:         o.parsed?.kind ?? null,
      mediaId:      o.parsed?.id ?? null,
      group:        o.parsed?.group ?? null,
      layout:       o.parsed ? (o.parsed.isPhase6BLayout ? "phase6b" : "flat") : "unparsed",
    })),
  }, null, 2));

  const csv: string[] = ["key,category,kind,mediaId,group,layout,size,lastModified"];
  for (const o of objects) {
    csv.push([
      csvEscape(o.key),
      o.category,
      o.parsed?.kind ?? "",
      o.parsed?.id   ?? "",
      o.parsed?.group ?? "",
      o.parsed ? (o.parsed.isPhase6BLayout ? "phase6b" : "flat") : "unparsed",
      String(o.size),
      o.lastModified?.toISOString() ?? "",
    ].join(","));
  }
  fs.writeFileSync(csvPath, csv.join("\n") + "\n");

  console.log(`[gc] report written:`);
  console.log(`       json: ${jsonPath}`);
  console.log(`       csv:  ${csvPath}`);

  // ── Phase 5: summary ───────────────────────────────────────────────────────
  console.log("\n──────── classification ────────");
  console.log(`bucket:             ${bucket}`);
  console.log(`endpoint:           ${endpointHost}`);
  console.log(`scanned kinds:      ${pathKinds.join(", ")}`);
  console.log(`total objects:      ${all.length}    (${humanBytes(objects.reduce((s, o) => s + o.size, 0))})`);
  console.log("");
  for (const cat of ALL_CATEGORIES) {
    const a = perCat[cat];
    const tag = deleteCategories.has(cat) ? "🗑 will delete" : NEVER_DELETE.has(cat) ? "🛡 protected" : "· keep";
    console.log(`  ${cat.padEnd(14)} ${String(a.count).padStart(7)}  ${humanBytes(a.bytes).padStart(10)}  ${tag}`);
  }

  // List of keys actually slated for deletion
  const toDelete = objects.filter((o) => deleteCategories.has(o.category)).map((o) => o.key);
  const reclaimBytes = objects.filter((o) => deleteCategories.has(o.category)).reduce((s, o) => s + o.size, 0);

  console.log("");
  console.log(`deletable now:      ${toDelete.length}    (${humanBytes(reclaimBytes)} reclaimable)`);

  if (!APPLY) {
    console.log(`\n[gc] REPORT-ONLY — no deletes performed. Re-run with --apply to delete the ${toDelete.length} object(s) above.`);
    await prisma.$disconnect();
    return;
  }

  if (toDelete.length === 0) {
    console.log("[gc] nothing to delete.");
    await prisma.$disconnect();
    return;
  }

  // ── Phase 6: confirm + delete ──────────────────────────────────────────────
  if (!SKIP_PROMPT) {
    const sample = toDelete.slice(0, 5);
    console.log("\nSample objects to be deleted:");
    for (const k of sample) console.log(`  - ${k}`);
    if (toDelete.length > sample.length) console.log(`  … and ${toDelete.length - sample.length} more`);

    const ok = await promptConfirm(
      `\nType "DELETE" to permanently remove ${toDelete.length} object(s) from bucket=${bucket}: `,
      "DELETE",
    );
    if (!ok) {
      console.log("[gc] aborted — confirmation did not match.");
      await prisma.$disconnect();
      process.exit(1);
    }
  }

  console.log(`[gc] deleting ${toDelete.length} object(s) from bucket=${bucket}…`);
  const { deleted, errors } = await deleteBatch(s3, bucket, toDelete);
  console.log(`[gc] deleted=${deleted}  errors=${errors.length}`);
  if (errors.length > 0) {
    const errLog = path.join(REPORT_DIR, `gc-orphan-media-${stamp}-errors.json`);
    fs.writeFileSync(errLog, JSON.stringify(errors, null, 2));
    console.error(`[gc] delete errors written to: ${errLog}`);
  }

  console.log(`\n[gc] DELETED in bucket=${bucket}. Reclaimed ${humanBytes(reclaimBytes)}.`);
  await prisma.$disconnect();
  if (errors.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error("[gc] fatal:", err);
  process.exit(1);
});
