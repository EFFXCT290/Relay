import type { PrismaClient } from "@prisma/client";

// Shared substring search over message bodies + voice-note transcripts, used
// by BOTH the per-conversation search (message.routes.ts) and the global
// inbox search (conversation.routes.ts) — one WHERE-clause-level exclusion
// rule, applied identically everywhere this feature can be reached from.

const SNIPPET_RADIUS = 50;

// Truncates `text` to a window around the first case-insensitive match of
// `query`, so a long message/transcript doesn't blow up the response. Falls
// back to a plain head-truncation if the match position can't be found
// (defensive only — every caller here already filtered for a match at the DB
// level, so this should never actually miss).
export function buildSnippet(text: string, query: string, radius = SNIPPET_RADIUS): string {
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) {
    return text.length > radius * 2 ? `${text.slice(0, radius * 2)}…` : text;
  }
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + query.length + radius);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

export type RawSearchHit = {
  conversationId: string;
  messageId: string;
  type: string;
  senderId: string;
  createdAt: Date;
  snippet: string;
  matchedIn: "body" | "transcript";
};

// Text messages only. The disappearing-message exclusion lives in the WHERE
// clause itself — a VIEWS-mode message, or a TIME-mode message not yet
// opened, is never returned by this query no matter what its body contains.
// This mirrors visibleBody()'s read gating in message.routes.ts, but as a
// query-level filter rather than a post-fetch check, so there is no code path
// that can accidentally match against a hidden body.
async function searchMessageBodies(
  prisma: PrismaClient,
  conversationIds: string[],
  q: string,
  take: number,
): Promise<RawSearchHit[]> {
  if (conversationIds.length === 0) return [];
  const rows = await prisma.message.findMany({
    where: {
      conversationId: { in: conversationIds },
      isDeleted: false,
      body: { contains: q, mode: "insensitive" },
      OR: [
        { disappear: { is: null } },
        { disappear: { is: { mode: "TIME", firstOpenedAt: { not: null } } } },
      ],
    },
    select: { id: true, conversationId: true, type: true, senderId: true, createdAt: true, body: true },
    orderBy: { createdAt: "desc" },
    take,
  });
  return rows.map((m) => ({
    conversationId: m.conversationId,
    messageId:      m.id,
    type:           m.type,
    senderId:       m.senderId,
    createdAt:      m.createdAt,
    snippet:        buildSnippet(m.body!, q),
    matchedIn:      "body" as const,
  }));
}

// Voice notes only. Message.disappear is only ever set by the text-send route
// (see message.routes.ts) — a voice/media message can never carry a
// MessageDisappearState row, so no disappear-state filter applies here.
// Soft-deleted parent messages are still excluded. transcriptStatus must be
// "ready" so a still-transcribing or failed transcript never participates.
async function searchVoiceTranscripts(
  prisma: PrismaClient,
  conversationIds: string[],
  q: string,
  take: number,
): Promise<RawSearchHit[]> {
  if (conversationIds.length === 0) return [];
  const rows = await prisma.messageAttachment.findMany({
    where: {
      type: "voice",
      message: { conversationId: { in: conversationIds }, isDeleted: false },
      media: {
        transcriptStatus: "ready",
        transcript: { path: ["fullText"], string_contains: q, mode: "insensitive" },
      },
    },
    select: {
      message: { select: { id: true, conversationId: true, type: true, senderId: true, createdAt: true } },
      media:   { select: { transcript: true } },
    },
    orderBy: { message: { createdAt: "desc" } },
    take,
  });
  return rows
    .map((r) => ({ ...r, fullText: (r.media.transcript as { fullText?: unknown } | null)?.fullText }))
    .filter((r): r is typeof r & { fullText: string } => typeof r.fullText === "string")
    .map((r) => ({
      conversationId: r.message.conversationId,
      messageId:      r.message.id,
      type:           r.message.type,
      senderId:       r.message.senderId,
      createdAt:      r.message.createdAt,
      snippet:        buildSnippet(r.fullText, q),
      matchedIn:      "transcript" as const,
    }));
}

// Merges both sources, most-recent-first — the ordering the per-conversation
// search UI jumps to (newest match first) and the global search reduces to
// one-per-conversation from (see conversation.routes.ts).
export async function searchMessages(
  prisma: PrismaClient,
  conversationIds: string[],
  q: string,
  take: number,
): Promise<RawSearchHit[]> {
  const [bodies, transcripts] = await Promise.all([
    searchMessageBodies(prisma, conversationIds, q, take),
    searchVoiceTranscripts(prisma, conversationIds, q, take),
  ]);
  return [...bodies, ...transcripts].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}
