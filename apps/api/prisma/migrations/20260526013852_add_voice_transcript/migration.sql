-- AlterTable
ALTER TABLE "Media" ADD COLUMN     "durationMs" INTEGER,
ADD COLUMN     "transcript" JSONB,
ADD COLUMN     "transcriptStatus" TEXT;
