import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import minioPlugin from "../../plugins/minio.js";
import { buildInitialManifest, writeManifest, readManifest, patchManifest } from "./media.manifest.js";

// Real MinIO integration test — no Postgres/Redis needed, media.manifest.ts
// only ever touches S3.
async function buildTestApp() {
  const app = Fastify({ logger: false });
  await app.register(minioPlugin);
  return app;
}

// Wraps a real S3Client so PutObjectCommand rejects (simulating a write
// failure — network blip, MinIO briefly unreachable, etc.) while every other
// command (GetObjectCommand) still goes through to real MinIO untouched.
function withFailingPut(s3: S3Client): S3Client {
  return {
    send: (cmd: unknown) => {
      if (cmd instanceof PutObjectCommand) {
        return Promise.reject(new Error("simulated write failure"));
      }
      return s3.send(cmd as never);
    },
  } as unknown as S3Client;
}

describe("media.manifest.ts — real MinIO read-modify-write", () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;

  before(async () => {
    app = await buildTestApp();
  });

  after(async () => {
    await app.close();
  });

  it("patchManifest reads the current manifest, applies the mutation, and persists it — a subsequent real read reflects the change", async () => {
    const mediaId = randomUUID();
    const opts = { kind: "images" as const, id: mediaId, date: new Date("2026-05-24T00:00:00Z") };
    const initial = buildInitialManifest({
      mediaId,
      storageKind: "images",
      deliveryMode: "optimized",
      isLss: false,
      isHevcSource: false,
      mime: "image/jpeg",
      originalKey: `images/2026/05/24/${mediaId}/original/source.jpg`,
      width: 100,
      height: 200,
    });
    await writeManifest(app.s3, initial, opts);

    const patched = await patchManifest(app.s3, opts, (draft) => {
      draft.variants.thumb_md = `images/2026/05/24/${mediaId}/thumbnails/thumb_md.webp`;
      draft.processing.thumbnail = "ready";
    });

    assert.ok(patched);
    assert.equal(patched!.variants.thumb_md, `images/2026/05/24/${mediaId}/thumbnails/thumb_md.webp`);
    assert.equal(patched!.processing.thumbnail, "ready");
    assert.equal(patched!.variants.original, initial.variants.original, "the mutation must be additive, not a full overwrite of pre-existing fields");

    // Independent real read confirms the write actually landed in MinIO, not
    // just in the in-memory draft.
    const reRead = await readManifest(app.s3, opts);
    assert.ok(reRead);
    assert.equal(reRead!.variants.thumb_md, `images/2026/05/24/${mediaId}/thumbnails/thumb_md.webp`);
    assert.equal(reRead!.processing.thumbnail, "ready");
  });

  it("returns null (no-op) when there's no manifest to patch yet — never fabricates one", async () => {
    const mediaId = randomUUID();
    const opts = { kind: "images" as const, id: mediaId, date: new Date("2026-05-24T00:00:00Z") };
    const result = await patchManifest(app.s3, opts, (draft) => {
      draft.processing.thumbnail = "ready";
    });
    assert.equal(result, null);
    assert.equal(await readManifest(app.s3, opts), null);
  });

  describe("patch write-failure — does it silently mask data loss?", () => {
    it("a failed write leaves the existing manifest fully intact and readable — the mutation is lost, but nothing already-persisted is corrupted or lost", async () => {
      const mediaId = randomUUID();
      const opts = { kind: "images" as const, id: mediaId, date: new Date("2026-05-24T00:00:00Z") };
      const initial = buildInitialManifest({
        mediaId,
        storageKind: "images",
        deliveryMode: "optimized",
        isLss: false,
        isHevcSource: false,
        mime: "image/jpeg",
        originalKey: `images/2026/05/24/${mediaId}/original/source.jpg`,
        width: 111,
        height: 222,
      });
      await writeManifest(app.s3, initial, opts);
      const beforeFailedPatch = await readManifest(app.s3, opts);
      assert.ok(beforeFailedPatch);

      // Simulate the write half of the read-modify-write failing (this is
      // exactly what media.worker.ts's `.catch((err) => log.warn(...))`
      // guards against at both its call sites).
      const failingS3 = withFailingPut(app.s3);
      await assert.rejects(
        () =>
          patchManifest(failingS3, opts, (draft) => {
            draft.variants.thumb_md = "this-write-should-never-land.webp";
            draft.processing.thumbnail = "ready";
          }),
        /simulated write failure/,
        "patchManifest must propagate the write failure to its caller (who is responsible for deciding whether to log-and-continue), not swallow it itself",
      );

      // The real assertion: read the REAL manifest back from MinIO (via the
      // unmodified client) and confirm it is byte-for-byte the pre-patch
      // state — S3/MinIO PUT is atomic, so a failed PutObjectCommand never
      // partially overwrites the existing object. Nothing is lost except the
      // update this one failed attempt tried to make.
      const afterFailedPatch = await readManifest(app.s3, opts);
      assert.ok(afterFailedPatch, "the manifest must still exist and be readable after a failed patch");
      assert.deepEqual(afterFailedPatch, beforeFailedPatch, "a failed write must leave the previously-persisted manifest completely unchanged");
      assert.equal(afterFailedPatch!.variants.thumb_md, undefined, "the failed mutation's data must not have landed");
      assert.equal(afterFailedPatch!.dimensions?.width, 111, "pre-existing fields survive a failed patch untouched");
    });
  });
});
