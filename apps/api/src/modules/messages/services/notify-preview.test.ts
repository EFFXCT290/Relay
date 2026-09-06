import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { previewFor as discordPreviewFor } from "./discord-notify.js";
import { previewFor as pushPreviewFor } from "./push-notify.js";

// push-notify.ts imports the module-level pushQueue (BullMQ) from
// push.queue.js, which opens a real ioredis connection at import time
// regardless of whether .add() is ever called — same transitive-import
// pattern documented in push-notify.test.ts/message.routes.test.ts (which
// also closes the media queues alongside pushQueue for the same reason).
// Left open, `node --test` never exits even though this file is pure logic.
after(async () => {
  const { pushQueue } = await import("../../../queues/push.queue.js");
  const { mediaQueue, videoQueue, voiceQueue } = await import("../../../queues/media.queue.js");
  await Promise.all([pushQueue.close(), mediaQueue.close(), videoQueue.close(), voiceQueue.close()]);
});

// discord-notify.ts and push-notify.ts each implement their OWN previewFor()
// — duplicated, not shared (see each file's own comment on this). Testing
// both against the SAME table both (a) confirms each truncates correctly on
// its own terms today, and (b) is exactly what would catch the two silently
// drifting apart in the future, which is the real risk duplication carries.
//
// Per the coverage plan: this is a "test both now, note as follow-up" item —
// deduplicating two already-working implementations into one shared helper
// is a refactor, not a bug fix, and is NOT done here.

type MessageType = "TEXT" | "IMAGE" | "VIDEO" | "AUDIO";

const cases: Array<{ label: string; messageType: MessageType; body: string | null; expected: string }> = [
  { label: "short TEXT body is returned unchanged", messageType: "TEXT", body: "hello", expected: "hello" },
  {
    label: "TEXT body at exactly 120 chars is NOT truncated (boundary: > not >=)",
    messageType: "TEXT",
    body: "x".repeat(120),
    expected: "x".repeat(120),
  },
  {
    label: "TEXT body at 121 chars IS truncated to 120 + ellipsis",
    messageType: "TEXT",
    body: "x".repeat(121),
    expected: "x".repeat(120) + "…",
  },
  {
    label: "TEXT body far past the limit truncates to exactly 120 chars + ellipsis",
    messageType: "TEXT",
    body: "x".repeat(500),
    expected: "x".repeat(120) + "…",
  },
  { label: "TEXT with a null body falls back to the generic '(message)' label", messageType: "TEXT", body: null, expected: "(message)" },
  { label: "TEXT with an empty-string body falls back to '(message)' too (falsy body)", messageType: "TEXT", body: "", expected: "(message)" },
  { label: "IMAGE ignores body entirely", messageType: "IMAGE", body: "should be ignored", expected: "📷 Image" },
  { label: "VIDEO ignores body entirely", messageType: "VIDEO", body: null, expected: "🎥 Video" },
  { label: "AUDIO ignores body entirely", messageType: "AUDIO", body: null, expected: "🎙️ Voice note" },
];

for (const [name, fn] of [
  ["discord-notify.ts's previewFor()", discordPreviewFor],
  ["push-notify.ts's previewFor()", pushPreviewFor],
] as const) {
  describe(name, () => {
    for (const c of cases) {
      it(c.label, () => {
        assert.equal(fn(c.messageType, c.body), c.expected);
      });
    }
  });
}

describe("discord-notify.ts and push-notify.ts's previewFor() — cross-check", () => {
  it("both implementations agree on every case in the table today (the thing worth re-running if either file changes)", () => {
    for (const c of cases) {
      const discordResult = discordPreviewFor(c.messageType, c.body);
      const pushResult    = pushPreviewFor(c.messageType, c.body);
      assert.equal(discordResult, pushResult, `mismatch for ${c.label}: discord="${discordResult}" push="${pushResult}"`);
    }
  });
});
