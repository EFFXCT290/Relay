// Dev helper — wipes all notifications for a username.
// Run:  pnpm exec tsx --env-file=/path/to/.env scripts/clear-alerts.ts <username>

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const target = process.argv[2];
  if (!target) {
    console.error("Usage: clear-alerts.ts <username>");
    process.exit(1);
  }
  const user = await prisma.user.findUnique({ where: { username: target } });
  if (!user) {
    console.error(`User @${target} not found.`);
    process.exit(1);
  }
  const res = await prisma.notification.deleteMany({ where: { userId: user.id } });
  console.log(`Deleted ${res.count} notifications for @${target}.`);
  await prisma.$disconnect();
}

void main();
