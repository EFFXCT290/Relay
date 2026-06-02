// Downscale + center-square-crop an image File to a webp Blob, entirely in the
// browser. Keeps the upload small and gives the user WYSIWYG (the server's
// fit:"cover" resize is only a backstop). The output edge is capped so we never
// ship a needlessly large file for a 256-px display target.
export async function cropToSquareWebp(file: File, edge = 512): Promise<Blob> {
  // imageOrientation:"from-image" bakes in EXIF rotation where supported, so the
  // crop is computed on the correctly-oriented pixels (the server also rotates).
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });

  const side = Math.min(bitmap.width, bitmap.height);
  const sx   = (bitmap.width  - side) / 2;
  const sy   = (bitmap.height - side) / 2;
  const target = Math.min(edge, side);

  const canvas = document.createElement("canvas");
  canvas.width  = target;
  canvas.height = target;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bitmap.close?.();
    throw new Error("Canvas is not supported in this browser.");
  }
  ctx.drawImage(bitmap, sx, sy, side, side, 0, 0, target, target);
  bitmap.close?.();

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/webp", 0.9),
  );
  if (!blob) throw new Error("Could not encode the image.");
  return blob;
}
