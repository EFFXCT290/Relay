// Canonical MinIO object-key layout. Media exists independently of any
// conversation/message, so keys are organized by kind + UTC date, never by
// owner or thread. One logical object (e.g. an image) owns several physical
// variants under a shared id prefix:
//
//   images/2026/05/24/<id>_original.jpg
//   images/2026/05/24/<id>_thumb.jpg
//   images/2026/05/24/<id>_blur.jpg
//   videos/2026/05/24/<id>_original.mp4
//   videos/2026/05/24/<id>_preview.jpg
//   voice/2026/05/24/<id>.opus
//
// Transient/system objects live outside the dated tree (temp/*, system/*).

export type MediaKind = "images" | "videos" | "voice";

/** Variants we may emit per kind. Image thumb/blur are Phase 2-deferred but the
 *  layout reserves their slots so keys stay stable when they ship. */
export type MediaVariant =
  | "original"
  | "blur"
  | "thumb"
  | "preview"
  | "waveform";

function datePath(date: Date): string {
  const yyyy = date.getUTCFullYear();
  const mm   = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd   = String(date.getUTCDate()).padStart(2, "0");
  return `${yyyy}/${mm}/${dd}`;
}

/**
 * Build the storage key for a media variant.
 * `ext` includes the dot (e.g. ".jpg"). `date` defaults to now (the upload
 * instant); pass an explicit date when backfilling so existing rows land in the
 * partition matching their original `createdAt`.
 */
export function buildMediaKey(opts: {
  kind:    MediaKind;
  id:      string;
  variant: MediaVariant;
  ext:     string;
  date?:   Date;
}): string {
  const { kind, id, variant, ext } = opts;
  return `${kind}/${datePath(opts.date ?? new Date())}/${id}_${variant}${ext}`;
}

/**
 * Recover the UTC date partition baked into an existing media key, e.g.
 * `images/2026/05/24/<id>_original.jpg` → 2026-05-24T00:00:00Z.
 *
 * Variants (blur/thumb/preview/...) MUST share the original's partition, so the
 * async worker derives its date from the original key rather than `new Date()`
 * — otherwise jobs that run (or retry) on a later UTC day scatter variants
 * across date folders. Returns null for legacy flat keys without a date path.
 */
export function parseMediaKeyDate(key: string): Date | null {
  const m = key.match(/^[a-z]+\/(\d{4})\/(\d{2})\/(\d{2})\//);
  if (!m) return null;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}
