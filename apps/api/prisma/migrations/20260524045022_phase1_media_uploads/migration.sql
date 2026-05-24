/*
  Warnings:

  - The values [VIEW_COUNT_UPDATE,MEDIA_EXPIRED] on the enum `NotificationType` will be removed. If these variants are still used in the database, this will fail.
  - You are about to drop the column `durationMs` on the `Media` table. All the data in the column will be lost.
  - You are about to drop the column `messageId` on the `Media` table. All the data in the column will be lost.
  - You are about to drop the column `minioKey` on the `Media` table. All the data in the column will be lost.
  - You are about to drop the column `quality` on the `Media` table. All the data in the column will be lost.
  - You are about to drop the column `status` on the `Media` table. All the data in the column will be lost.
  - You are about to alter the column `sizeBytes` on the `Media` table. The data in that column could be lost. The data in that column will be cast from `BigInt` to `Integer`.
  - You are about to drop the column `viewConfig` on the `Message` table. All the data in the column will be lost.
  - You are about to drop the `MediaAccessLog` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `ViewEvent` table. If the table is not empty, all the data it contains will be lost.
  - A unique constraint covering the columns `[storageKey]` on the table `Media` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `storageKey` to the `Media` table without a default value. This is not possible if the table is not empty.
  - Added the required column `uploaderId` to the `Media` table without a default value. This is not possible if the table is not empty.
  - Made the column `sizeBytes` on table `Media` required. This step will fail if there are existing NULL values in that column.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "NotificationType_new" AS ENUM ('SYSTEM_ALERT', 'MESSAGE_RECEIVED');
ALTER TABLE "Notification" ALTER COLUMN "type" TYPE "NotificationType_new" USING ("type"::text::"NotificationType_new");
ALTER TYPE "NotificationType" RENAME TO "NotificationType_old";
ALTER TYPE "NotificationType_new" RENAME TO "NotificationType";
DROP TYPE "public"."NotificationType_old";
COMMIT;

-- DropForeignKey
ALTER TABLE "Media" DROP CONSTRAINT "Media_messageId_fkey";

-- DropForeignKey
ALTER TABLE "MediaAccessLog" DROP CONSTRAINT "MediaAccessLog_mediaId_fkey";

-- DropForeignKey
ALTER TABLE "MediaAccessLog" DROP CONSTRAINT "MediaAccessLog_userId_fkey";

-- DropForeignKey
ALTER TABLE "ViewEvent" DROP CONSTRAINT "ViewEvent_messageId_fkey";

-- DropIndex
DROP INDEX "Media_minioKey_key";

-- AlterTable
ALTER TABLE "Media" DROP COLUMN "durationMs",
DROP COLUMN "messageId",
DROP COLUMN "minioKey",
DROP COLUMN "quality",
DROP COLUMN "status",
ADD COLUMN     "storageKey" TEXT NOT NULL,
ADD COLUMN     "uploaderId" TEXT NOT NULL,
ALTER COLUMN "sizeBytes" SET NOT NULL,
ALTER COLUMN "sizeBytes" SET DATA TYPE INTEGER;

-- AlterTable
ALTER TABLE "Message" DROP COLUMN "viewConfig";

-- DropTable
DROP TABLE "MediaAccessLog";

-- DropTable
DROP TABLE "ViewEvent";

-- DropEnum
DROP TYPE "MediaAction";

-- DropEnum
DROP TYPE "MediaQuality";

-- DropEnum
DROP TYPE "MediaStatus";

-- CreateTable
CREATE TABLE "MessageAttachment" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "mediaId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MessageAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MessageAttachment_messageId_idx" ON "MessageAttachment"("messageId");

-- CreateIndex
CREATE UNIQUE INDEX "Media_storageKey_key" ON "Media"("storageKey");

-- AddForeignKey
ALTER TABLE "Media" ADD CONSTRAINT "Media_uploaderId_fkey" FOREIGN KEY ("uploaderId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageAttachment" ADD CONSTRAINT "MessageAttachment_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageAttachment" ADD CONSTRAINT "MessageAttachment_mediaId_fkey" FOREIGN KEY ("mediaId") REFERENCES "Media"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
