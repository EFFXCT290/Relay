// ffmpeg-backed video processing (Phase 6B, 6B.6 / 6B.14). All operations are
// file-in/file-out: ffmpeg needs seekable inputs and we keep buffers off the
// heap for large videos by round-tripping through the OS temp dir. Every temp
// file is cleaned up in a finally.
//
// Two delivery paths:
//   • optimized (H.264 source) → transcode an adaptive ladder (downscale-only)
//   • LSS / HEVC source        → remux/passthrough to a faststart MP4 (no
//                                 re-encode); HEVC stays HEVC, just normalized.
// Poster, animated preview and thumbnails are produced for both paths.
import { spawn } from "node:child_process";
import { writeFile, readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { env } from "../../backend-core/runtime/env.js";

// Adaptive resolution ladder (height → CRF). We only emit rungs at or below the
// source height (never upscale). 4K uses a higher CRF since detail masks it.
export const H264_LADDER: { height: number; label: string; crf: number }[] = [
  { height: 480,  label: "480p",  crf: 23 },
  { height: 720,  label: "720p",  crf: 22 },
  { height: 1080, label: "1080p", crf: 21 },
  { height: 2160, label: "4k",    crf: 24 },
];

/** Pick ladder rungs for a source height — downscale-only, always ≥1 rung. */
export function ladderFor(sourceHeight: number | null): { height: number; label: string; crf: number }[] {
  if (!sourceHeight) return [H264_LADDER[1]!]; // unknown → assume 720p target
  const rungs = H264_LADDER.filter((r) => r.height <= sourceHeight);
  if (rungs.length > 0) return rungs;
  // Source smaller than the lowest rung → one rung at the native height.
  return [{ height: sourceHeight, label: `${sourceHeight}p`, crf: 23 }];
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(env.FFMPEG_BIN, ["-v", "error", "-y", ...args]);
    let stderr = "";
    proc.stderr.on("data", (d) => (stderr += d));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(Object.assign(new Error(`ffmpeg exited ${code}`), { code, stderr: stderr.slice(0, 4000) }));
    });
  });
}

function tmp(suffix: string): string {
  return join(tmpdir(), `relay-vid-${randomUUID()}${suffix}`);
}

/**
 * Run an ffmpeg op that reads `input` and produces one output file, returning
 * the output bytes. Caller supplies the args between input and output.
 */
async function transform(
  input:     Buffer,
  outSuffix: string,
  buildArgs: (inPath: string, outPath: string) => string[],
): Promise<Buffer> {
  const inPath  = tmp(".src");
  const outPath = tmp(outSuffix);
  await writeFile(inPath, input);
  try {
    await runFfmpeg(buildArgs(inPath, outPath));
    return await readFile(outPath);
  } finally {
    await Promise.all([unlink(inPath).catch(() => {}), unlink(outPath).catch(() => {})]);
  }
}

/** Transcode to H.264/AAC MP4 at the given height (faststart, yuv420p). */
export function transcodeH264(input: Buffer, height: number, crf: number): Promise<Buffer> {
  return transform(input, ".mp4", (i, o) => [
    "-i", i,
    "-vf", `scale=-2:${height}`,        // -2 keeps aspect with an even width
    "-c:v", "libx264",
    "-preset", env.VIDEO_H264_PRESET,
    "-crf", String(crf),
    "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "128k",
    "-movflags", "+faststart",
    o,
  ]);
}

/** Container-normalize without re-encoding (HEVC passthrough / LSS). */
export function remuxPassthrough(input: Buffer): Promise<Buffer> {
  return transform(input, ".mp4", (i, o) => [
    "-i", i,
    "-c", "copy",
    "-tag:v", "hvc1",                    // Apple/Safari-friendly HEVC tag; ignored for non-HEVC copy
    "-movflags", "+faststart",
    o,
  ]);
}

/** Extract a single poster frame (PNG bytes) near the start of the clip. */
export function extractPosterFrame(input: Buffer, atSeconds = 1): Promise<Buffer> {
  return transform(input, ".png", (i, o) => [
    "-ss", String(atSeconds),
    "-i", i,
    "-frames:v", "1",
    o,
  ]);
}

/** Short, muted, downscaled looping preview (animated thumbnail). */
export function animatedPreview(input: Buffer, seconds = 3, height = 360): Promise<Buffer> {
  return transform(input, ".mp4", (i, o) => [
    "-i", i,
    "-t", String(seconds),
    "-an",
    "-vf", `scale=-2:${height}`,
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "30",
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    o,
  ]);
}
