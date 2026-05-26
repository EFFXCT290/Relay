// ffprobe-backed media inspection. Used to (a) read intrinsic video metadata
// (codec, dimensions, duration) for the manifest and (b) drive the HEVC auto-LSS
// rule (6B.4): HEVC/H.265 sources are never transcoded, so we classify them LSS
// at upload time regardless of the user's chosen delivery mode.
//
// ffprobe needs a seekable input for many container formats, so we probe a temp
// file rather than piping stdin. The temp file is always unlinked.
import { spawn } from "node:child_process";
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { env } from "../../backend-core/runtime/env.js";

// `ffprobe` lives beside ffmpeg; reuse FFMPEG_BIN's directory if it's a path.
const FFPROBE_BIN = env.FFMPEG_BIN.includes("/")
  ? env.FFMPEG_BIN.replace(/ffmpeg([^/]*)$/, "ffprobe$1")
  : "ffprobe";

export interface VideoProbe {
  codec:      string | null;   // e.g. "h264", "hevc"
  width:      number | null;
  height:     number | null;
  durationMs: number | null;
  isHevc:     boolean;         // hevc / h265
}

function runFfprobe(path: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFPROBE_BIN, [
      "-v", "error",
      "-print_format", "json",
      "-show_streams",
      "-show_format",
      path,
    ]);
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d));
    proc.stderr.on("data", (d) => (stderr += d));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(Object.assign(new Error(`ffprobe exited ${code}`), { code, stderr }));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (err) {
        reject(err);
      }
    });
  });
}

type FfprobeStream = {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  duration?: string;
  tags?: { rotate?: string };
  side_data_list?: { side_data_type?: string; rotation?: number }[];
};
type FfprobeResult = {
  streams?: FfprobeStream[];
  format?: { duration?: string };
};

/**
 * Read the stream's rotation from either the legacy `tags.rotate` or the modern
 * Display Matrix side-data. iPhone/portrait clips are stored landscape with a
 * ±90° matrix, so the DISPLAY dimensions are the encoded ones swapped. We never
 * alter the video — we just report what the player will actually show, so the
 * bubble sizes correctly (no pillarbox/black bars).
 */
function rotationDegrees(video: FfprobeStream | undefined): number {
  const tag = Number(video?.tags?.rotate);
  if (Number.isFinite(tag) && tag !== 0) return tag;
  const dm = video?.side_data_list?.find((s) => s.side_data_type === "Display Matrix");
  if (dm && typeof dm.rotation === "number") return dm.rotation;
  return 0;
}

/** Probe a video buffer for its primary video stream's codec + DISPLAY dims. */
export async function probeVideo(buffer: Buffer): Promise<VideoProbe> {
  const path = join(tmpdir(), `relay-probe-${randomUUID()}`);
  await writeFile(path, buffer);
  try {
    const result = (await runFfprobe(path)) as FfprobeResult;
    const video  = result.streams?.find((s) => s.codec_type === "video");
    const codec  = video?.codec_name?.toLowerCase() ?? null;
    const durSec =
      Number(video?.duration) ||
      Number(result.format?.duration) ||
      NaN;

    // Swap W/H for quarter-turn rotations so we store the orientation the user
    // actually sees (portrait stays portrait), without re-encoding the video.
    const encW = video?.width  ?? null;
    const encH = video?.height ?? null;
    const swap = Math.abs(rotationDegrees(video)) % 180 === 90;

    return {
      codec,
      width:      swap ? encH : encW,
      height:     swap ? encW : encH,
      durationMs: Number.isFinite(durSec) ? Math.round(durSec * 1000) : null,
      isHevc:     codec === "hevc" || codec === "h265",
    };
  } finally {
    await unlink(path).catch(() => {});
  }
}

/**
 * Resolve the effective delivery mode (6B.2 + 6B.4). The user's request is
 * honored unless the source forces LSS: HEVC video and DNG raw are never
 * re-encoded, so they are promoted to LSS even when "optimized" was requested.
 */
export function resolveDeliveryMode(opts: {
  requested: "optimized" | "lss";
  isHevc:    boolean;
  isDng:     boolean;
}): { deliveryMode: "optimized" | "lss"; autoPromoted: boolean } {
  const forced = opts.isHevc || opts.isDng;
  if (forced && opts.requested === "optimized") {
    return { deliveryMode: "lss", autoPromoted: true };
  }
  return { deliveryMode: opts.requested, autoPromoted: false };
}
