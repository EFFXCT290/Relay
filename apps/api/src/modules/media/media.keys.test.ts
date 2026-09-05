import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  buildMediaPrefix,
  buildManifestKey,
  buildVariantKey,
  parseMediaKeyDate,
  parseMediaPrefix,
  kindToPath,
  assertPhase6BKey,
  isPhase6BKeyError,
  Phase6BKeyError,
  MANIFEST_FILENAME,
  type MediaGroup,
  type MediaKind,
} from "./media.keys.js";

// Pure-function unit tests — no Fastify, no DB. media.keys.ts is graphify's
// #5 god node repo-wide (15 edges) with 0 prior coverage: every media
// derivative (blur, thumb, optimized, manifest, ...) and the S3 write-time
// guard route through here, so a bug here has the widest blast radius of
// anything in the media pipeline.

const KINDS: MediaKind[] = ["images", "videos", "voice"];
const GROUPS: MediaGroup[] = [
  "original", "optimized", "thumbnails", "previews", "waveforms", "transcripts", "metadata",
];

describe("media.keys.ts — build/parse round-trip", () => {
  for (const kind of KINDS) {
    it(`buildVariantKey → parseMediaPrefix round-trips (kind=${kind})`, () => {
      const id = randomUUID();
      const date = new Date(Date.UTC(2026, 4, 24)); // 2026-05-24, matches the doc example
      const key = buildVariantKey({ kind, id, group: "optimized", filename: "display.webp", date });

      assert.equal(key, `${kind}/2026/05/24/${id}/optimized/display.webp`);

      const parsed = parseMediaPrefix(key);
      assert.ok(parsed, "expected parseMediaPrefix to recognize a key it could build");
      assert.equal(parsed!.kind, kind);
      assert.equal(parsed!.id, id);
      assert.equal(parsed!.date.getTime(), date.getTime());
      assert.equal(parsed!.prefix, buildMediaPrefix({ kind, id, date }));
    });
  }

  for (const group of GROUPS) {
    it(`buildVariantKey round-trips through every MediaGroup (group=${group})`, () => {
      const id = randomUUID();
      const date = new Date(Date.UTC(2025, 11, 1));
      const key = buildVariantKey({ kind: "images", id, group, filename: "f.bin", date });
      const parsed = parseMediaPrefix(key);
      assert.ok(parsed);
      assert.equal(parsed!.id, id);
      assert.equal(parsed!.date.getTime(), date.getTime());
    });
  }

  it("buildMediaPrefix defaults to the current date when none is given", () => {
    const id = randomUUID();
    const before = new Date();
    const prefix = buildMediaPrefix({ kind: "images", id });
    const after = new Date();

    const parsed = parseMediaPrefix(`${prefix}/original/x.jpg`);
    assert.ok(parsed);
    // Compare only the UTC calendar date — datePath() truncates to Y/M/D.
    const truncate = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    assert.ok(
      parsed!.date.getTime() >= truncate(before) && parsed!.date.getTime() <= truncate(after),
      "default date should fall within the test's execution window",
    );
  });

  it("buildManifestKey uses group=metadata and the canonical manifest filename", () => {
    const id = randomUUID();
    const date = new Date(Date.UTC(2026, 0, 15));
    const key = buildManifestKey({ kind: "videos", id, date });
    assert.equal(key, `videos/2026/01/15/${id}/metadata/${MANIFEST_FILENAME}`);
    assert.equal(key, buildVariantKey({ kind: "videos", id, group: "metadata", filename: MANIFEST_FILENAME, date }));
  });

  it("parseMediaKeyDate round-trips against buildVariantKey's date for every kind", () => {
    for (const kind of KINDS) {
      const date = new Date(Date.UTC(2024, 2, 9)); // 2024-03-09
      const key = buildVariantKey({ kind, id: randomUUID(), group: "original", filename: "source.bin", date });
      const parsed = parseMediaKeyDate(key);
      assert.ok(parsed);
      assert.equal(parsed!.getTime(), date.getTime());
    }
  });

  it("parseMediaKeyDate also matches the legacy flat layout (no per-id folder)", () => {
    const legacyKey = "images/2026/05/24/abc123_original.jpg";
    const parsed = parseMediaKeyDate(legacyKey);
    assert.ok(parsed);
    assert.equal(parsed!.getTime(), Date.UTC(2026, 4, 24));
  });

  it("parseMediaPrefix returns null for the legacy flat layout (no per-id folder)", () => {
    assert.equal(parseMediaPrefix("images/2026/05/24/abc123_original.jpg"), null);
  });

  it("parseMediaKeyDate returns null for a key with no date partition", () => {
    assert.equal(parseMediaKeyDate("not-a-media-key.jpg"), null);
  });

  it("parseMediaPrefix returns null for an unrecognized kind", () => {
    assert.equal(parseMediaPrefix(`documents/2026/05/24/${randomUUID()}/original/f.pdf`), null);
  });

  it("kindToPath maps the Prisma enum to the storage path segment", () => {
    assert.equal(kindToPath("IMAGE"), "images");
    assert.equal(kindToPath("VIDEO"), "videos");
    assert.equal(kindToPath("VOICE"), "voice");
  });
});

describe("assertPhase6BKey — 6 throw conditions, table-driven", () => {
  const validId = randomUUID();
  const validKey = `images/2026/05/24/${validId}/original/source.jpg`;

  it("accepts a well-formed Phase-6B key without throwing", () => {
    assert.doesNotThrow(() => assertPhase6BKey(validKey));
  });

  const cases: Array<{ name: string; key: string; code: string }> = [
    {
      name: "wrong segment count (missing the group/filename split)",
      key: `images/2026/05/24/${validId}/original_source.jpg`, // 6 segments, not 7
      code: "media.phase6b.INVALID_SEGMENT_COUNT",
    },
    {
      name: "malformed kind (not images/videos/voice)",
      key: `photos/2026/05/24/${validId}/original/source.jpg`,
      code: "media.phase6b.UNKNOWN_KIND",
    },
    {
      name: "malformed date partition (year not 4 digits)",
      key: `images/26/05/24/${validId}/original/source.jpg`,
      code: "media.phase6b.INVALID_DATE_PARTITION",
    },
    {
      name: "malformed UUID (not a valid UUID shape)",
      key: `images/2026/05/24/not-a-uuid/original/source.jpg`,
      code: "media.phase6b.INVALID_MEDIA_ID",
    },
    {
      name: "malformed group (not a known MediaGroup)",
      key: `images/2026/05/24/${validId}/weird/source.jpg`,
      code: "media.phase6b.UNKNOWN_GROUP",
    },
    {
      name: "malformed filename (contains a path separator)",
      key: `images/2026/05/24/${validId}/original/nested\\traversal.jpg`,
      code: "media.phase6b.UNSAFE_FILENAME",
    },
  ];

  for (const { name, key, code } of cases) {
    it(`throws ${code} for: ${name}`, () => {
      assert.throws(
        () => assertPhase6BKey(key),
        (err: unknown) => {
          assert.ok(err instanceof Phase6BKeyError, "expected a Phase6BKeyError instance");
          assert.ok(isPhase6BKeyError(err), "isPhase6BKeyError type guard should also recognize it");
          assert.equal((err as Phase6BKeyError).code, code);
          assert.equal((err as Phase6BKeyError).key, key);
          assert.match((err as Phase6BKeyError).message, /\[media\]/, "message should carry a clear, structured prefix");
          return true;
        },
      );
    });
  }

  it("also rejects an empty filename segment as UNSAFE_FILENAME (not a segment-count mismatch)", () => {
    const key = `images/2026/05/24/${validId}/original/`; // trailing slash → empty last segment, still 7 parts
    assert.throws(
      () => assertPhase6BKey(key),
      (err: unknown) => {
        assert.ok(isPhase6BKeyError(err));
        assert.equal((err as Phase6BKeyError).code, "media.phase6b.UNSAFE_FILENAME");
        return true;
      },
    );
  });

  it("rejects an uppercase UUID as INVALID_MEDIA_ID (randomUUID() output is always lowercase)", () => {
    const key = `images/2026/05/24/${validId.toUpperCase()}/original/source.jpg`;
    assert.throws(
      () => assertPhase6BKey(key),
      (err: unknown) => {
        assert.ok(isPhase6BKeyError(err));
        assert.equal((err as Phase6BKeyError).code, "media.phase6b.INVALID_MEDIA_ID");
        return true;
      },
    );
  });
});
