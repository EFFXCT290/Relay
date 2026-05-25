-- DropIndex
DROP INDEX "EventOutbox_recipientId_ackedAt_createdAt_idx";

-- AlterTable
ALTER TABLE "EventOutbox" ADD COLUMN     "conversationId" TEXT;

-- CreateIndex
CREATE INDEX "EventOutbox_recipientId_ackedAt_createdAt_id_idx" ON "EventOutbox"("recipientId", "ackedAt", "createdAt", "id");
