-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'NICKNAME_SHARED';

-- CreateTable
CREATE TABLE "UserNickname" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "targetUserId" TEXT NOT NULL,
    "nickname" TEXT NOT NULL,
    "sharedWithTarget" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserNickname_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UserNickname_targetUserId_idx" ON "UserNickname"("targetUserId");

-- CreateIndex
CREATE UNIQUE INDEX "UserNickname_ownerId_targetUserId_key" ON "UserNickname"("ownerId", "targetUserId");

-- AddForeignKey
ALTER TABLE "UserNickname" ADD CONSTRAINT "UserNickname_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserNickname" ADD CONSTRAINT "UserNickname_targetUserId_fkey" FOREIGN KEY ("targetUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
