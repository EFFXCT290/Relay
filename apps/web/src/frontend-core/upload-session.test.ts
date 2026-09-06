import { describe, it, expect, beforeEach } from "vitest";
import { saveSession, drainSessions, type UploadSession } from "./upload-session";

const CONV_ID = "conv-1";

function makeSession(overrides: Partial<UploadSession> = {}): UploadSession {
  return {
    sessionId: overrides.sessionId ?? crypto.randomUUID(),
    conversationId: overrides.conversationId ?? CONV_ID,
    fileCount: overrides.fileCount ?? 2,
    clientUploadIds: overrides.clientUploadIds ?? ["u1", "u2"],
    mediaIds: overrides.mediaIds ?? [],
    status: overrides.status ?? "uploading",
    createdAt: overrides.createdAt ?? Date.now(),
  };
}

beforeEach(() => {
  localStorage.clear();
});

describe("drainSessions() — resumable vs. orphaned classification", () => {
  it("a 'sending' session (all uploads done, POST not yet sent) is classified as resumable", () => {
    const session = makeSession({ status: "sending", mediaIds: ["m1", "m2"] });
    saveSession(session);

    const { resumable, orphaned } = drainSessions(CONV_ID);

    expect(resumable).toHaveLength(1);
    expect(resumable[0]!.sessionId).toBe(session.sessionId);
    expect(resumable[0]!.mediaIds).toEqual(["m1", "m2"]);
    expect(orphaned).toHaveLength(0);
  });

  it("an 'uploading' session (files not yet all sent to MinIO) is classified as orphaned, not resumable", () => {
    const session = makeSession({ status: "uploading" });
    saveSession(session);

    const { resumable, orphaned } = drainSessions(CONV_ID);

    expect(orphaned).toHaveLength(1);
    expect(orphaned[0]!.sessionId).toBe(session.sessionId);
    expect(resumable).toHaveLength(0);
  });

  it("a 'completed' session is neither resumable nor orphaned — it's dropped entirely", () => {
    saveSession(makeSession({ status: "completed" }));

    const { resumable, orphaned } = drainSessions(CONV_ID);

    expect(resumable).toHaveLength(0);
    expect(orphaned).toHaveLength(0);
  });

  it("correctly buckets a mix of sessions across different statuses in one call", () => {
    const sending1 = makeSession({ status: "sending" });
    const sending2 = makeSession({ status: "sending" });
    const uploading1 = makeSession({ status: "uploading" });
    saveSession(sending1);
    saveSession(sending2);
    saveSession(uploading1);
    saveSession(makeSession({ status: "completed" })); // must not appear in either bucket

    const { resumable, orphaned } = drainSessions(CONV_ID);

    expect(resumable.map((s) => s.sessionId).sort()).toEqual([sending1.sessionId, sending2.sessionId].sort());
    expect(orphaned.map((s) => s.sessionId)).toEqual([uploading1.sessionId]);
  });

  it("only drains sessions for the requested conversationId — a session for a different conversation is left untouched", () => {
    const otherConv = makeSession({ conversationId: "conv-2", status: "sending" });
    saveSession(otherConv);

    const { resumable, orphaned } = drainSessions(CONV_ID);
    expect(resumable).toHaveLength(0);
    expect(orphaned).toHaveLength(0);

    // It's still there, untouched, when drained for ITS OWN conversation.
    const { resumable: otherResumable } = drainSessions("conv-2");
    expect(otherResumable.map((s) => s.sessionId)).toEqual([otherConv.sessionId]);
  });

  it("a drained session (resumable or orphaned) is removed from storage — calling drainSessions again does not return it twice", () => {
    saveSession(makeSession({ status: "sending" }));
    saveSession(makeSession({ status: "uploading" }));

    const first = drainSessions(CONV_ID);
    expect(first.resumable).toHaveLength(1);
    expect(first.orphaned).toHaveLength(1);

    const second = drainSessions(CONV_ID);
    expect(second.resumable).toHaveLength(0);
    expect(second.orphaned).toHaveLength(0);
  });

  it("an expired session (older than the 1-hour TTL) is pruned and returned in neither bucket", () => {
    const oneHourMs = 60 * 60 * 1000;
    const expired = makeSession({ status: "sending", createdAt: Date.now() - oneHourMs - 1 });
    saveSession(expired);

    const { resumable, orphaned } = drainSessions(CONV_ID);
    expect(resumable).toHaveLength(0);
    expect(orphaned).toHaveLength(0);
  });
});
