-- CreateEnum
CREATE TYPE "DisappearMode" AS ENUM ('VIEWS', 'TIME');

-- CreateTable
CREATE TABLE "MessageDisappearState" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "mode" "DisappearMode" NOT NULL,
    "viewLimit" INTEGER,
    "viewCount" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3),
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MessageDisappearState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MessageDisappearState_messageId_key" ON "MessageDisappearState"("messageId");

-- CreateIndex
CREATE INDEX "MessageDisappearState_mode_consumedAt_expiresAt_idx" ON "MessageDisappearState"("mode", "consumedAt", "expiresAt");

-- AddForeignKey
ALTER TABLE "MessageDisappearState" ADD CONSTRAINT "MessageDisappearState_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;
