import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { ladderFor, H264_LADDER, remuxPassthrough } from "./media.transcode.js";

const exec = promisify(execFile);

// Pure-function unit test — no ffmpeg subprocess.

function heights(rungs: ReturnType<typeof ladderFor>): number[] {
  return rungs.map((r) => r.height);
}

describe("ladderFor() — downscale-only rung selection", () => {
  it("a 4K source gets all four rungs", () => {
    assert.deepEqual(heights(ladderFor(2160)), [480, 720, 1080, 2160]);
  });

  it("a 1080p source gets three rungs, excluding 4k", () => {
    assert.deepEqual(heights(ladderFor(1080)), [480, 720, 1080]);
  });

  it("a 720p source gets two rungs, excluding 1080p and 4k", () => {
    assert.deepEqual(heights(ladderFor(720)), [480, 720]);
  });

  it("a source exactly at the lowest rung (480) gets exactly that one rung", () => {
    assert.deepEqual(heights(ladderFor(480)), [480]);
  });

  it("never includes a rung taller than the source (no upscaling) — e.g. 800p excludes 1080p/4k", () => {
    const rungs = heights(ladderFor(800));
    assert.deepEqual(rungs, [480, 720]);
    assert.ok(rungs.every((h) => h <= 800));
  });

  it("smaller-than-lowest-rung fallback: a source below 480 gets exactly ONE rung at its own native height, not upscaled to 480", () => {
    const rungs = ladderFor(240);
    assert.equal(rungs.length, 1);
    assert.equal(rungs[0]!.height, 240, "must not upscale to the 480 rung");
    assert.equal(rungs[0]!.label, "240p");
  });

  it("smaller-than-lowest-rung fallback right at the boundary (479, one below the lowest rung)", () => {
    const rungs = ladderFor(479);
    assert.equal(rungs.length, 1);
    assert.equal(rungs[0]!.height, 479);
  });

  it("an unknown/null source height falls back to a 720p target (not the fallback-rung path)", () => {
    const rungs = ladderFor(null);
    assert.equal(rungs.length, 1);
    assert.equal(rungs[0]!.height, 720);
    assert.deepEqual(rungs[0], H264_LADDER[1]);
  });

  it("every rung returned is one of the canonical H264_LADDER entries when the source is at/above the lowest rung", () => {
    for (const rung of ladderFor(1080)) {
      assert.ok(H264_LADDER.includes(rung), "rungs should be the same object references as H264_LADDER entries");
    }
  });
});

// Real ffmpeg-generated test pattern videos — no checked-in fixtures, same
// pattern as media.worker.test.ts's generateTestVideo().
async function generateTestVideo(codec: "libx264" | "libx265"): Promise<Buffer> {
  const outPath = `/tmp/relay-transcode-test-${randomUUID()}.mp4`;
  await exec("ffmpeg", [
    "-f", "lavfi", "-i", "testsrc=duration=1:size=320x240:rate=10",
    "-c:v", codec, "-pix_fmt", "yuv420p", "-y", outPath,
  ]);
  const buf = await readFile(outPath);
  await unlink(outPath).catch(() => {});
  return buf;
}

async function probeTag(buf: Buffer): Promise<{ codecName: string; codecTag: string }> {
  const path = `/tmp/relay-transcode-probe-${randomUUID()}.mp4`;
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path, buf);
  try {
    const { stdout } = await exec("ffprobe", [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=codec_name,codec_tag_string",
      "-of", "default=noprint_wrappers=1",
      path,
    ]);
    const codecName = /codec_name=(\S+)/.exec(stdout)?.[1] ?? "";
    const codecTag  = /codec_tag_string=(\S+)/.exec(stdout)?.[1] ?? "";
    return { codecName, codecTag };
  } finally {
    await unlink(path).catch(() => {});
  }
}

// Regression coverage for a real production crash: media.worker.ts:419 routes
// ANY isLss=true upload through remuxPassthrough() — not just isHevc=true ones
// (LSS is a legitimate, always-available client choice, "give me the original
// without re-encoding," not an HEVC-exclusive mode; resolveDeliveryMode() only
// FORCES LSS for HEVC/DNG, it never restricts LSS to them). remuxPassthrough()
// used to force `-tag:v hvc1` on every remux unconditionally, so a genuinely
// H.264 upload with isLss=true crashed deterministically: ffmpeg refused with
// "Tag hvc1 incompatible with output codec id '27' (avc1)", exit 183 —
// reproduced empirically against a real local ffmpeg before this fix existed.
describe("remuxPassthrough() — hvc1 tag only forced for genuinely HEVC sources", () => {
  it("a genuinely H.264 source (the exact production crash: isLss without isHevc) remuxes successfully and is NOT tagged hvc1", async () => {
    const h264 = await generateTestVideo("libx264");
    const before = await probeTag(h264);
    assert.equal(before.codecName, "h264", "sanity check: fixture must actually be H.264");

    const out = await remuxPassthrough(h264, false);
    const after = await probeTag(out);
    assert.equal(after.codecName, "h264", "remux must not re-encode — still H.264");
    assert.notEqual(after.codecTag, "hvc1", "a non-HEVC remux must never be tagged hvc1");
  });

  it("a genuinely HEVC source (isHevc=true) is still tagged hvc1 — the original intended behavior, not just the fix", async () => {
    const hevc = await generateTestVideo("libx265");
    const before = await probeTag(hevc);
    assert.equal(before.codecName, "hevc", "sanity check: fixture must actually be HEVC");

    const out = await remuxPassthrough(hevc, true);
    const after = await probeTag(out);
    assert.equal(after.codecName, "hevc", "remux must not re-encode — still HEVC");
    assert.equal(after.codecTag, "hvc1", "a genuinely HEVC remux must still get the Apple/Safari-compatible hvc1 tag");
  });
});
