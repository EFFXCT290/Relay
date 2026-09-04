// One-time (re-runnable, idempotent) cleanup for EventOutbox rows that
// reference a conversationId or recipientId that no longer exists. Companion
// to check-event-outbox-orphans.ts (run that first) and a prerequisite for
// the migration that adds a hard FK from EventOutbox to Conversation/User —
// that migration fails outright if any orphaned rows still exist at apply
// time.
//
// Safety: dry-run by default — prints exactly which rows WOULD be deleted and
// exits without touching anything. Pass --confirm to actually delete. Row IDs
// are queried fresh on every run (never hardcoded), so this always reflects
// whatever the live data actually looks like right now, not a stale snapshot.
import { PrismaClient } from "@prisma/client";

const CONFIRM = process.argv.includes("--confirm");

type OrphanRow = {
  id: string;
  eventName: string;
  conversationId: string | null;
  recipientId: string;
  ackedAt: Date | null;
  createdAt: Date;
};

async function main() {
  const prisma = new PrismaClient();

  // Union of both orphan kinds, deduped by id — a row can be orphaned by
  // conversationId, by recipientId, or both.
  const orphans = await prisma.$queryRaw<OrphanRow[]>`
    SELECT eo.id, eo."eventName", eo."conversationId", eo."recipientId", eo."ackedAt", eo."createdAt"
    FROM "EventOutbox" eo
    WHERE (eo."conversationId" IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM "Conversation" c WHERE c.id = eo."conversationId"))
       OR NOT EXISTS (SELECT 1 FROM "User" u WHERE u.id = eo."recipientId")
    ORDER BY eo."createdAt" DESC
  `;

  console.log(`Found ${orphans.length} orphaned EventOutbox row(s):`);
  console.log(JSON.stringify(orphans, null, 2));

  if (orphans.length === 0) {
    console.log("Nothing to delete.");
    await prisma.$disconnect();
    return;
  }

  if (!CONFIRM) {
    console.log(`\nDry run only — no rows deleted. Re-run with --confirm to delete these ${orphans.length} row(s).`);
    await prisma.$disconnect();
    return;
  }

  // Delete exactly the rows just listed above — not a live re-evaluation of
  // the NOT EXISTS filter at delete time — so what gets deleted is guaranteed
  // to match what was just printed for review.
  const ids = orphans.map((o) => o.id);
  const result = await prisma.eventOutbox.deleteMany({ where: { id: { in: ids } } });
  console.log(`\nDeleted ${result.count} row(s).`);

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
