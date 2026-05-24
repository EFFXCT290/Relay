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
  | "thumb"
  | "blur"
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
