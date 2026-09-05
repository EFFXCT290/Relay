import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ladderFor, H264_LADDER } from "./media.transcode.js";

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
