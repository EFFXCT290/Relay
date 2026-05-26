-- CreateEnum
CREATE TYPE "MediaKind" AS ENUM ('IMAGE', 'VIDEO', 'VOICE');

-- CreateEnum
CREATE TYPE "MediaDeliveryMode" AS ENUM ('OPTIMIZED', 'LSS');

-- CreateEnum
CREATE TYPE "MediaVariantType" AS ENUM ('ORIGINAL', 'OPTIMIZED', 'POSTER', 'PREVIEW', 'THUMBNAIL', 'WAVEFORM');

-- CreateEnum
CREATE TYPE "MediaTaskType" AS ENUM ('TRANSCODE', 'THUMBNAIL', 'POSTER', 'WAVEFORM', 'TRANSCRIPT');

-- CreateEnum
CREATE TYPE "MediaTaskState" AS ENUM ('PENDING', 'PROCESSING', 'READY', 'FAILED');

-- AlterTable
ALTER TABLE "Media" ADD COLUMN     "deliveryMode" "MediaDeliveryMode" NOT NULL DEFAULT 'OPTIMIZED',
ADD COLUMN     "isHevcSource" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "isLss" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "kind" "MediaKind";

-- CreateTable
CREATE TABLE "MediaVariant" (
    "id" TEXT NOT NULL,
    "mediaId" TEXT NOT NULL,
    "type" "MediaVariantType" NOT NULL,
    "label" TEXT,
    "storageKey" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "codec" TEXT,
    "width" INTEGER,
    "height" INTEGER,
    "bitrate" INTEGER,
    "sizeBytes" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MediaVariant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MediaProcessingTask" (
    "id" TEXT NOT NULL,
    "mediaId" TEXT NOT NULL,
    "type" "MediaTaskType" NOT NULL,
    "state" "MediaTaskState" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MediaProcessingTask_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MediaVariant_storageKey_key" ON "MediaVariant"("storageKey");

-- CreateIndex
CREATE INDEX "MediaVariant_mediaId_idx" ON "MediaVariant"("mediaId");

-- CreateIndex
CREATE UNIQUE INDEX "MediaVariant_mediaId_type_label_key" ON "MediaVariant"("mediaId", "type", "label");

-- CreateIndex
CREATE INDEX "MediaProcessingTask_mediaId_idx" ON "MediaProcessingTask"("mediaId");

-- CreateIndex
CREATE INDEX "MediaProcessingTask_state_idx" ON "MediaProcessingTask"("state");

-- CreateIndex
CREATE UNIQUE INDEX "MediaProcessingTask_mediaId_type_key" ON "MediaProcessingTask"("mediaId", "type");

-- AddForeignKey
ALTER TABLE "MediaVariant" ADD CONSTRAINT "MediaVariant_mediaId_fkey" FOREIGN KEY ("mediaId") REFERENCES "Media"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaProcessingTask" ADD CONSTRAINT "MediaProcessingTask_mediaId_fkey" FOREIGN KEY ("mediaId") REFERENCES "Media"("id") ON DELETE CASCADE ON UPDATE CASCADE;
