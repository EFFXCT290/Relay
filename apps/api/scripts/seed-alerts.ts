// One-off dev helper — seeds a handful of demo notifications for a username
// so the /alerts UI has content to render. Idempotent enough for repeated runs
// (will keep stacking notifications; safe).
//
// Run:  pnpm --filter @relay/api exec tsx --env-file=../../.env scripts/seed-alerts.ts <username>

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const target = process.argv[2];
  if (!target) {
    console.error("Usage: seed-alerts.ts <username>");
    process.exit(1);
  }

  const user = await prisma.user.findUnique({ where: { username: target } });
  if (!user) {
    console.error(`User @${target} not found.`);
    process.exit(1);
  }

  const now = Date.now();
  const minutesAgo = (n: number) => new Date(now - n * 60_000);
  const hoursAgo = (n: number) => new Date(now - n * 3_600_000);
  const daysAgo = (n: number) => new Date(now - n * 86_400_000);

  const rows = await prisma.user.findMany({
    where: { id: { not: user.id } },
    take: 3,
    select: { id: true, username: true },
  });
  // Spec uses `userId`, not `id`, in notification payloads — map here so the
  // frontend can read the same shape it gets from real events later.
  const others = rows.map((r) => ({ userId: r.id, username: r.username }));
  const someone = (i: number) =>
    others[i] ?? { userId: "00000000-0000-0000-0000-000000000000", username: "ghost" };

  const created = await prisma.notification.createMany({
    data: [
      {
        userId: user.id,
        type: "SYSTEM_ALERT",
        isRead: false,
        createdAt: minutesAgo(2),
        payload: {
          capturedBy: someone(0),
          eventType: "SCREENSHOT_ATTEMPT",
          trigger: "visibilitychange burst",
          timestamp: minutesAgo(2).toISOString(),
          mediaId: "00000000-0000-0000-0000-000000000aa1",
          userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) Safari/605.1.15",
          platform: "iOS",
        },
      },
      {
        userId: user.id,
        type: "VIEW_COUNT_UPDATE",
        isRead: false,
        createdAt: minutesAgo(18),
        payload: {
          viewer: someone(0),
          messageId: "00000000-0000-0000-0000-000000000aa2",
          viewsUsed: 2,
          viewsAllowed: 3,
        },
      },
      {
        userId: user.id,
        type: "MEDIA_EXPIRED",
        isRead: true,
        createdAt: hoursAgo(4),
        payload: {
          recipient: someone(1),
          messageId: "00000000-0000-0000-0000-000000000aa3",
          expiredAt: hoursAgo(4).toISOString(),
        },
      },
      {
        userId: user.id,
        type: "MESSAGE_RECEIVED",
        isRead: true,
        createdAt: hoursAgo(20),
        payload: {
          from: someone(0),
          preview: "hey are you free later?",
          messageId: "00000000-0000-0000-0000-000000000aa4",
        },
      },
      {
        userId: user.id,
        type: "VIEW_COUNT_UPDATE",
        isRead: true,
        createdAt: daysAgo(2),
        payload: {
          viewer: someone(1),
          messageId: "00000000-0000-0000-0000-000000000aa5",
          viewsUsed: 1,
          viewsAllowed: 1,
        },
      },
    ],
  });

  console.log(`Seeded ${created.count} notifications for @${target}.`);
  await prisma.$disconnect();
}

void main();
