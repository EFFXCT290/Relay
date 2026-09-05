import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { rotationDegrees, parseProbeResult, resolveDeliveryMode } from "./media.probe.js";

type Stream = Parameters<typeof rotationDegrees>[0];
type ProbeResult = Parameters<typeof parseProbeResult>[0];

// Pure-function unit tests — no I/O, no real ffprobe subprocess.

describe("rotationDegrees()", () => {
  it("reads the legacy tags.rotate value when non-zero", () => {
    const video: Stream = { codec_type: "video", tags: { rotate: "90" } };
    assert.equal(rotationDegrees(video), 90);
  });

  it("ignores tags.rotate when it's exactly 0 and falls through to Display Matrix", () => {
    const video: Stream = {
      codec_type: "video",
      tags: { rotate: "0" },
      side_data_list: [{ side_data_type: "Display Matrix", rotation: -90 }],
    };
    assert.equal(rotationDegrees(video), -90);
  });

  it("reads the modern Display Matrix side-data when there's no legacy tag", () => {
    const video: Stream = {
      codec_type: "video",
      side_data_list: [{ side_data_type: "Display Matrix", rotation: 180 }],
    };
    assert.equal(rotationDegrees(video), 180);
  });

  it("legacy tag takes precedence over Display Matrix when both are present", () => {
    const video: Stream = {
      codec_type: "video",
      tags: { rotate: "270" },
      side_data_list: [{ side_data_type: "Display Matrix", rotation: 90 }],
    };
    assert.equal(rotationDegrees(video), 270);
  });

  it("ignores a side_data entry that isn't Display Matrix", () => {
    const video: Stream = {
      codec_type: "video",
      side_data_list: [{ side_data_type: "Something Else", rotation: 90 }],
    };
    assert.equal(rotationDegrees(video), 0);
  });

  it("returns 0 for an undefined stream, or one with neither source", () => {
    assert.equal(rotationDegrees(undefined), 0);
    assert.equal(rotationDegrees({ codec_type: "video" }), 0);
  });
});

describe("parseProbeResult() — width/height swap on rotation", () => {
  function makeResult(opts: { width: number; height: number; rotateTag?: string; matrixRotation?: number; codec?: string; duration?: string }): ProbeResult {
    return {
      streams: [
        {
          codec_type: "video",
          codec_name: opts.codec ?? "h264",
          width: opts.width,
          height: opts.height,
          duration: opts.duration,
          ...(opts.rotateTag != null ? { tags: { rotate: opts.rotateTag } } : {}),
          ...(opts.matrixRotation != null
            ? { side_data_list: [{ side_data_type: "Display Matrix", rotation: opts.matrixRotation }] }
            : {}),
        },
      ],
    };
  }

  it("no rotation: width/height pass through unchanged", () => {
    const probe = parseProbeResult(makeResult({ width: 1920, height: 1080 }));
    assert.equal(probe.width, 1920);
    assert.equal(probe.height, 1080);
  });

  it("90° rotation (legacy tag): encoded landscape dims are swapped to display portrait", () => {
    const probe = parseProbeResult(makeResult({ width: 1920, height: 1080, rotateTag: "90" }));
    assert.equal(probe.width, 1080);
    assert.equal(probe.height, 1920);
  });

  it("270° rotation (legacy tag): also swapped (quarter turn either direction)", () => {
    const probe = parseProbeResult(makeResult({ width: 1920, height: 1080, rotateTag: "270" }));
    assert.equal(probe.width, 1080);
    assert.equal(probe.height, 1920);
  });

  it("-90° rotation (Display Matrix): swapped", () => {
    const probe = parseProbeResult(makeResult({ width: 1920, height: 1080, matrixRotation: -90 }));
    assert.equal(probe.width, 1080);
    assert.equal(probe.height, 1920);
  });

  it("180° rotation: NOT swapped (upside-down, not a quarter turn)", () => {
    const probe = parseProbeResult(makeResult({ width: 1920, height: 1080, rotateTag: "180" }));
    assert.equal(probe.width, 1920);
    assert.equal(probe.height, 1080);
  });

  it("codec, isHevc, and durationMs are still resolved correctly alongside a swap", () => {
    const probe = parseProbeResult(makeResult({ width: 1920, height: 1080, rotateTag: "90", codec: "HEVC", duration: "2.5" }));
    assert.equal(probe.codec, "hevc");
    assert.equal(probe.isHevc, true);
    assert.equal(probe.durationMs, 2500);
    assert.equal(probe.width, 1080);
    assert.equal(probe.height, 1920);
  });

  it("no video stream at all → nulls, not a throw", () => {
    const probe = parseProbeResult({ streams: [] });
    assert.equal(probe.codec, null);
    assert.equal(probe.width, null);
    assert.equal(probe.height, null);
    assert.equal(probe.durationMs, null);
    assert.equal(probe.isHevc, false);
  });

  it("falls back to format.duration when the stream itself reports none", () => {
    const result: ProbeResult = {
      streams: [{ codec_type: "video", codec_name: "h264", width: 100, height: 100 }],
      format: { duration: "3.0" },
    };
    assert.equal(parseProbeResult(result).durationMs, 3000);
  });
});

describe("resolveDeliveryMode()", () => {
  it("HEVC auto-promotes an 'optimized' request to 'lss'", () => {
    const r = resolveDeliveryMode({ requested: "optimized", isHevc: true, isDng: false });
    assert.deepEqual(r, { deliveryMode: "lss", autoPromoted: true });
  });

  it("DNG auto-promotes an 'optimized' request to 'lss'", () => {
    const r = resolveDeliveryMode({ requested: "optimized", isHevc: false, isDng: true });
    assert.deepEqual(r, { deliveryMode: "lss", autoPromoted: true });
  });

  it("HEVC + DNG together still just promotes once (no double-effect)", () => {
    const r = resolveDeliveryMode({ requested: "optimized", isHevc: true, isDng: true });
    assert.deepEqual(r, { deliveryMode: "lss", autoPromoted: true });
  });

  it("a non-HEVC, non-DNG 'optimized' request is honored, not auto-promoted", () => {
    const r = resolveDeliveryMode({ requested: "optimized", isHevc: false, isDng: false });
    assert.deepEqual(r, { deliveryMode: "optimized", autoPromoted: false });
  });

  it("an explicit 'lss' request is honored regardless of format — never marked auto-promoted", () => {
    assert.deepEqual(resolveDeliveryMode({ requested: "lss", isHevc: true, isDng: false }), { deliveryMode: "lss", autoPromoted: false });
    assert.deepEqual(resolveDeliveryMode({ requested: "lss", isHevc: false, isDng: false }), { deliveryMode: "lss", autoPromoted: false });
  });
});
