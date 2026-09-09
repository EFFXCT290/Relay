import type { FastifyInstance } from "fastify";

// "Connected" = there exists a 1:1 conversation between subjectId and a
// candidate where BOTH sides have accepted (Participant.acceptedAt set on
// each). One conversation with only one side accepted (a pending request in
// either direction) does NOT count — this is the gate for whether a
// stranger's real avatarUrl may ever leave the server for a given viewer.
// Batched (one query for the whole candidate set), mirroring
// myNicknamesFor/spotifySummariesFor/presencesFor's existing pattern in
// conversation.routes.ts.
export async function connectedUserIds(
  fastify: FastifyInstance,
  subjectId: string,
  candidateIds: string[],
): Promise<Set<string>> {
  const uniqueCandidates = [...new Set(candidateIds)].filter((id) => id !== subjectId);
  if (uniqueCandidates.length === 0) return new Set();

  const rows = await fastify.prisma.participant.findMany({
    where: {
      userId: { in: uniqueCandidates },
      acceptedAt: { not: null },
      conversation: {
        participants: { some: { userId: subjectId, acceptedAt: { not: null } } },
      },
    },
    select: { userId: true },
    distinct: ["userId"],
  });
  return new Set(rows.map((r) => r.userId));
}

// Single-pair convenience wrapper for call sites with exactly one other
// user (POST /conversations, GET /conversations/:id, GET /users/:userId) —
// same query shape as the batched form, just without a Map/Set to unwrap.
export async function isConnected(
  fastify: FastifyInstance,
  subjectId: string,
  candidateId: string,
): Promise<boolean> {
  return (await connectedUserIds(fastify, subjectId, [candidateId])).has(candidateId);
}
