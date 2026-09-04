import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";

// Real integration test — real Postgres (the throwaway CI service), not a
// mock. EventOutbox previously had zero FK/relation to Conversation or User
// (bare conversationId/recipientId strings) — deleting a conversation left
// its outbox rows orphaned forever. This confirms the new onDelete: Cascade
// relations (prisma/migrations/20260904162607_add_event_outbox_relations)
// actually clean them up. No HTTP layer involved, so no Fastify app needed.
describe("EventOutbox -> Conversation/User cascade delete", () => {
  let prisma: PrismaClient;
  let userAId: string; // recipient for the conversation-delete case
  let userBId: string; // recipient for the user-delete case

  before(async () => {
    prisma = new PrismaClient();

    const suffix = randomUUID().slice(0, 8);
    const passwordHash = "not-a-real-hash"; // not exercised by this test
    const passwordSalt = randomBytes(32).toString("hex"); // matches passwordSalt @db.Char(64)

    const [userA, userB] = await Promise.all([
      prisma.user.create({ data: { username: `outbox-cascade-a-${suffix}`, passwordHash, passwordSalt } }),
      prisma.user.create({ data: { username: `outbox-cascade-b-${suffix}`, passwordHash, passwordSalt } }),
    ]);
    userAId = userA.id;
    userBId = userB.id;
  });

  after(async () => {
    // Each test deletes its own row(s) as the thing under test; this is a
    // defensive backstop in case a test fails before reaching its own delete.
    await prisma.user.deleteMany({ where: { id: { in: [userAId, userBId] } } });
    await prisma.$disconnect();
  });

  it("deleting a Conversation cascades to its EventOutbox rows", async () => {
    const conversation = await prisma.conversation.create({ data: {} });
    const outbox = await prisma.eventOutbox.create({
      data: {
        eventId:        randomUUID(),
        eventName:      "message:new",
        conversationId: conversation.id,
        payload:        {},
        recipientId:    userAId,
      },
    });

    await prisma.conversation.delete({ where: { id: conversation.id } });

    const stillThere = await prisma.eventOutbox.findUnique({ where: { id: outbox.id } });
    assert.equal(stillThere, null);
  });

  it("deleting a User cascades to their EventOutbox rows, including user-global (null conversationId) events", async () => {
    const outbox = await prisma.eventOutbox.create({
      data: {
        eventId:        randomUUID(),
        eventName:      "notification:new",
        conversationId: null,
        payload:        {},
        recipientId:    userBId,
      },
    });

    await prisma.user.delete({ where: { id: userBId } });

    const stillThere = await prisma.eventOutbox.findUnique({ where: { id: outbox.id } });
    assert.equal(stillThere, null);
  });
});
