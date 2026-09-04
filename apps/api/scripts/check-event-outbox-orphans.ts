// Read-only pre-flight check for the EventOutbox -> Conversation/User FK
// migration. EventOutbox.conversationId and .recipientId are currently bare
// strings with no @relation (schema.prisma:447-459), so nothing has ever
// enforced referential integrity on them. A migration that adds a hard FK
// constraint will fail outright if any row already references a
// conversationId/recipientId that no longer exists — run this FIRST and read
// the counts before writing that migration.
//
// Strictly read-only: every statement below is a SELECT/COUNT. No UPDATE,
// DELETE, or DDL. Safe to run against production as many times as needed.
import { PrismaClient } from "@prisma/client";

async function main() {
  const prisma = new PrismaClient();

  const totalRows = await prisma.eventOutbox.count();

  const orphanedByConversation = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::bigint AS count
    FROM "EventOutbox" eo
    WHERE eo."conversationId" IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM "Conversation" c WHERE c.id = eo."conversationId")
  `;

  const orphanedByRecipient = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::bigint AS count
    FROM "EventOutbox" eo
    WHERE NOT EXISTS (SELECT 1 FROM "User" u WHERE u.id = eo."recipientId")
  `;

  // Sample a few orphaned rows (id/eventName/createdAt/ackedAt only — no
  // payload contents) so a human can judge whether they're old/acked/dead
  // rather than something recent that might indicate a live bug.
  const sampleOrphanedByConversation = await prisma.$queryRaw<
    { id: string; eventName: string; conversationId: string; ackedAt: Date | null; createdAt: Date }[]
  >`
    SELECT eo.id, eo."eventName", eo."conversationId", eo."ackedAt", eo."createdAt"
    FROM "EventOutbox" eo
    WHERE eo."conversationId" IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM "Conversation" c WHERE c.id = eo."conversationId")
    ORDER BY eo."createdAt" DESC
    LIMIT 10
  `;

  const sampleOrphanedByRecipient = await prisma.$queryRaw<
    { id: string; eventName: string; recipientId: string; ackedAt: Date | null; createdAt: Date }[]
  >`
    SELECT eo.id, eo."eventName", eo."recipientId", eo."ackedAt", eo."createdAt"
    FROM "EventOutbox" eo
    WHERE NOT EXISTS (SELECT 1 FROM "User" u WHERE u.id = eo."recipientId")
    ORDER BY eo."createdAt" DESC
    LIMIT 10
  `;

  console.log(
    JSON.stringify(
      {
        totalEventOutboxRows: totalRows,
        orphanedByConversationId: Number(orphanedByConversation[0]?.count ?? 0n),
        orphanedByRecipientId: Number(orphanedByRecipient[0]?.count ?? 0n),
        sampleOrphanedByConversationId: sampleOrphanedByConversation,
        sampleOrphanedByRecipientId: sampleOrphanedByRecipient,
      },
      null,
      2,
    ),
  );

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
