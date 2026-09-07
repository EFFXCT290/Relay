import { describe, it, type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { PrismaClient } from "@prisma/client";
import type { S3Client } from "@aws-sdk/client-s3";

// Regression coverage for the uploadVideo() probeVideo()-failure classification
// (media.service.ts, ~line 244): a missing/misconfigured ffprobe binary
// (ENOENT) was previously indistinguishable from a genuinely corrupt/unsupported
// video file — both surfaced as the identical "unsupported_mime" 422, which is
// exactly what turned a Dockerfile gap (no ffmpeg in the runtime image) into a
// multi-round investigation instead of a one-line log. This can't easily be a
// real end-to-end test of "is ffprobe actually missing" without either shipping
// a container image without ffmpeg or manipulating this process's PATH, so it
// mocks probeVideo() directly and asserts on the resulting error `code` instead
// — the thing the route handler (media.routes.ts) actually branches on.
//
// Must run with --experimental-test-module-mocks (already required elsewhere
// in this suite, e.g. calls.push.test.ts).
async function freshUploadVideo(t: TestContext, probeVideoImpl: (buffer: Buffer) => Promise<unknown>) {
  const probeUrl = new URL("./media.probe.ts", import.meta.url).href;
  const realProbe = await import("./media.probe.js");
  t.mock.module(probeUrl, {
    namedExports: {
      ...realProbe,
      probeVideo: probeVideoImpl,
    },
  });

  // Neither test ever reaches the enqueue step (probeVideo() always throws
  // first), but media.service.ts imports media.queue.ts at module scope,
  // which opens real BullMQ/Redis connections as a side effect of import.
  // Importing the real module even just to spread its other exports would
  // still pay that cost (the import itself runs the file, Queue construction
  // included) and reproduce the exact "asynchronous activity after the test
  // ended" noise this is trying to avoid — a connection barely finished
  // handshaking before this file's synchronous, near-instant test already
  // completed. So this mock never imports the real module at all; the two
  // job-name constants are copied as literals (media.queue.ts:11-12) since
  // they're structurally irrelevant here (uploadVideo() only reads them to
  // pass to Queue.add(), never invoked on this failure path).
  const queueUrl = new URL("../../queues/media.queue.ts", import.meta.url).href;
  t.mock.module(queueUrl, {
    namedExports: {
      mediaQueue: { add: async () => {} },
      videoQueue: { add: async () => {} },
      PROCESS_IMAGE_JOB: "process-image",
      PROCESS_VIDEO_JOB: "process-video",
    },
  });

  const serviceUrl = new URL("./media.service.ts", import.meta.url).href + `?t=${Math.random()}`;
  const mod = await import(serviceUrl);
  return mod.uploadVideo as typeof import("./media.service.js").uploadVideo;
}

const fakePrisma = {} as PrismaClient;
const fakeS3 = {} as S3Client;

// A real, tiny buffer is enough — mediaKindFromMime/size checks run for real
// before probeVideo() is ever reached, and both pass for any non-empty buffer
// under the size limit tagged as video/mp4.
const buffer = Buffer.from("not actually a video, but never decoded in this test");

describe("uploadVideo() — probeVideo() failure classification", () => {
  it("an ENOENT from probeVideo (ffprobe binary missing/unreachable) maps to processing_unavailable, not unsupported_mime", async (t) => {
    const uploadVideo = await freshUploadVideo(t, async () => {
      throw Object.assign(new Error("spawn ffprobe ENOENT"), { code: "ENOENT", syscall: "spawn ffprobe" });
    });

    await assert.rejects(
      () => uploadVideo(buffer, "video/mp4", "user-1", fakePrisma, fakeS3, null, "optimized"),
      (err: unknown) => {
        assert.equal((err as { code?: string }).code, "processing_unavailable");
        return true;
      },
    );
  });

  it("a non-ENOENT probeVideo failure (genuinely unreadable video) still maps to unsupported_mime", async (t) => {
    const uploadVideo = await freshUploadVideo(t, async () => {
      throw Object.assign(new Error("ffprobe exited 1"), { code: 1, stderr: "Invalid data found when processing input" });
    });

    await assert.rejects(
      () => uploadVideo(buffer, "video/mp4", "user-1", fakePrisma, fakeS3, null, "optimized"),
      (err: unknown) => {
        assert.equal((err as { code?: string }).code, "unsupported_mime");
        return true;
      },
    );
  });
});
