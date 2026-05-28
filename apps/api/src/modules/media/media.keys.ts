// Canonical MinIO object-key layout. Media exists independently of any
// conversation/message, so keys are organized by kind + UTC date + per-mediaId
// folder. Every derivative of one media object lives under the same prefix:
//
//   images/2026/05/24/<id>/original/source.jpg
//   images/2026/05/24/<id>/optimized/display.webp
//   images/2026/05/24/<id>/thumbnails/thumb_md.webp
//   videos/2026/05/24/<id>/original/source.mov
//   voice/2026/05/24/<id>/original/source.opus
//
// Transient/system objects live outside the dated tree (temp/*, system/*).

export type MediaKind = "images" | "videos" | "voice";

function datePath(date: Date): string {
  const yyyy = date.getUTCFullYear();
  const mm   = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd   = String(date.getUTCDate()).padStart(2, "0");
  return `${yyyy}/${mm}/${dd}`;
}

/**
 * Recover the UTC date partition baked into an existing media key, e.g.
 * `images/2026/05/24/<id>_original.jpg` → 2026-05-24T00:00:00Z.
 *
 * Variants (blur/thumb/preview/...) MUST share the original's partition, so the
 * async worker derives its date from the original key rather than `new Date()`
 * — otherwise jobs that run (or retry) on a later UTC day scatter variants
 * across date folders. Returns null for legacy flat keys without a date path.
 *
 * Matches both the legacy flat layout (`images/Y/M/D/<id>_original.jpg`) and the
 * Phase-6B folder layout (`images/Y/M/D/<id>/original/source.jpg`).
 */
export function parseMediaKeyDate(key: string): Date | null {
  const m = key.match(/^[a-z]+\/(\d{4})\/(\d{2})\/(\d{2})\//);
  if (!m) return null;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

// ────────────────────────────────────────────────────────────────────────────
//  Phase 6B — per-mediaId folder layout
// ────────────────────────────────────────────────────────────────────────────
// Every derivative of one media object lives under a single prefix so cleanup,
// retries, migration and CDN purge target `kind/YYYY/MM/DD/<id>/*`. Workers are
// stateless: given (kind, id, date) they derive any key deterministically. The
// date is recovered from the original key via parseMediaKeyDate so all variants
// share the original's partition regardless of when the worker runs.
//
//   images/2026/05/26/<id>/
//   ├── original/source.jpg
//   ├── optimized/display.webp · display@2x.webp · display.avif
//   ├── thumbnails/thumb_sm.webp · thumb_md.webp · thumb_lg.webp
//   └── metadata/manifest.json
//   videos/2026/05/26/<id>/
//   ├── original/source.mov
//   ├── optimized/stream_1080p.mp4 · stream_720p.mp4 · …
//   ├── previews/poster.webp · poster.jpg · animated_preview.mp4
//   ├── thumbnails/thumb_md.webp
//   └── metadata/manifest.json

/** Sub-directories under a media prefix. One per logical group of derivatives. */
export type MediaGroup =
  | "original"
  | "optimized"
  | "thumbnails"
  | "previews"
  | "waveforms"
  | "transcripts"
  | "metadata";

export const MANIFEST_FILENAME = "manifest.json";

/** `kind/YYYY/MM/DD/<id>` — the shared prefix for all of a media object's keys. */
export function buildMediaPrefix(opts: { kind: MediaKind; id: string; date?: Date }): string {
  return `${opts.kind}/${datePath(opts.date ?? new Date())}/${opts.id}`;
}

/** A single object key within a media prefix, e.g. `…/<id>/optimized/display.webp`. */
export function buildVariantKey(opts: {
  kind:     MediaKind;
  id:       string;
  group:    MediaGroup;
  filename: string;
  date?:    Date;
}): string {
  const { kind, id, group, filename, date } = opts;
  return `${buildMediaPrefix({ kind, id, date })}/${group}/${filename}`;
}

/** Canonical manifest key for a media object. */
export function buildManifestKey(opts: { kind: MediaKind; id: string; date?: Date }): string {
  return buildVariantKey({ ...opts, group: "metadata", filename: MANIFEST_FILENAME });
}

/**
 * Recover (kind, id, date, prefix) from any key in the Phase-6B folder layout.
 * Lets a stateless worker, given only an original key, derive every sibling key.
 * Returns null for the legacy flat layout (no `<id>/` segment).
 */
export function parseMediaPrefix(
  key: string,
): { kind: MediaKind; id: string; date: Date; prefix: string } | null {
  const m = key.match(/^(images|videos|voice)\/(\d{4})\/(\d{2})\/(\d{2})\/([^/]+)\//);
  if (!m) return null;
  const kind = m[1] as MediaKind;
  const date = new Date(Date.UTC(Number(m[2]), Number(m[3]) - 1, Number(m[4])));
  const id   = m[5]!;
  return { kind, id, date, prefix: `${kind}/${m[2]}/${m[3]}/${m[4]}/${id}` };
}

/** Map the Prisma MediaKind enum (IMAGE/VIDEO/VOICE) to the storage path segment. */
export function kindToPath(kind: "IMAGE" | "VIDEO" | "VOICE"): MediaKind {
  return kind === "IMAGE" ? "images" : kind === "VIDEO" ? "videos" : "voice";
}

// ────────────────────────────────────────────────────────────────────────────
//  Phase-6B enforcement
// ────────────────────────────────────────────────────────────────────────────

const _ALLOWED_KINDS  = new Set<string>(["images", "videos", "voice"]);
// Exhaustive: adding a new MediaGroup without updating this set is a compile-time
// omission but a runtime catch — the assertion will reject the unknown group.
const _ALLOWED_GROUPS = new Set<string>([
  "original", "optimized", "thumbnails", "previews", "waveforms", "transcripts", "metadata",
]);
const _UUID_RE      = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const _DATE2_RE     = /^\d{2}$/;
const _SAFE_FILE_RE = /^[^/\\]+$/; // no slashes, no backslashes

export const PHASE6B_ERROR_NAMESPACE = "media.phase6b" as const;

// Short violation names used internally; the public code is always namespaced.
type _Phase6BViolation =
  | "INVALID_SEGMENT_COUNT"
  | "UNKNOWN_KIND"
  | "INVALID_DATE_PARTITION"
  | "INVALID_MEDIA_ID"
  | "UNKNOWN_GROUP"
  | "UNSAFE_FILENAME";

/** Fully-qualified error code, e.g. `"media.phase6b.UNKNOWN_GROUP"`.
 *  The namespace prefix makes log filtering unambiguous in Grafana / Datadog
 *  and avoids collisions if other pipelines introduce similar violation names. */
export type Phase6BKeyErrorCode = `${typeof PHASE6B_ERROR_NAMESPACE}.${_Phase6BViolation}`;

/** Thrown by assertPhase6BKey. Carries a machine-readable `code` and the
 *  `key` that was rejected so callers can branch and log without string parsing. */
export class Phase6BKeyError extends Error {
  readonly code: Phase6BKeyErrorCode;
  readonly key:  string;

  constructor(violation: _Phase6BViolation, key: string, detail: string) {
    super(`[media] ${detail} — key: "${key}"`);
    this.name = "Phase6BKeyError";
    this.code = `${PHASE6B_ERROR_NAMESPACE}.${violation}`;
    this.key  = key;
  }
}

/**
 * Type guard that identifies Phase6BKeyError by name rather than instanceof,
 * which is unreliable across ESM module boundaries and bundled workers where
 * two separate class references can exist for the same logical class.
 */
export function isPhase6BKeyError(err: unknown): err is Phase6BKeyError {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { name?: unknown }).name === "Phase6BKeyError"
  );
}

/**
 * Throws a Phase6BKeyError if `key` does not conform to the Phase-6B layout.
 * Validates each segment semantically:
 *   - kind     ∈ {images, videos, voice}
 *   - YYYY/MM/DD — numeric date partition
 *   - id       — UUID (randomUUID() output)
 *   - group    ∈ known MediaGroup values
 *   - filename — no path separators or traversal sequences
 *
 * Call before every PutObjectCommand so a regression is caught at write time
 * with a precise, structured error rather than silently landing a non-6B key.
 */
export function assertPhase6BKey(key: string): void {
  const parts = key.split("/");
  if (parts.length !== 7)
    throw new Phase6BKeyError("INVALID_SEGMENT_COUNT", key, `expected 7 segments, got ${parts.length}`);

  const [kind, yyyy, mm, dd, id, group, filename] = parts as [string, string, string, string, string, string, string];

  if (!_ALLOWED_KINDS.has(kind))
    throw new Phase6BKeyError("UNKNOWN_KIND", key, `unknown kind "${kind}"`);
  if (!/^\d{4}$/.test(yyyy) || !_DATE2_RE.test(mm) || !_DATE2_RE.test(dd))
    throw new Phase6BKeyError("INVALID_DATE_PARTITION", key, `invalid date partition "${yyyy}/${mm}/${dd}"`);
  if (!_UUID_RE.test(id))
    throw new Phase6BKeyError("INVALID_MEDIA_ID", key, `mediaId is not a UUID ("${id}")`);
  if (!_ALLOWED_GROUPS.has(group))
    throw new Phase6BKeyError("UNKNOWN_GROUP", key, `unknown group "${group}"`);
  if (!filename || !_SAFE_FILE_RE.test(filename) || filename.includes(".."))
    throw new Phase6BKeyError("UNSAFE_FILENAME", key, `unsafe filename "${filename}"`);
}
