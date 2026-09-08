-- AlterTable
ALTER TABLE "MessageDisappearState" ADD COLUMN     "firstOpenedAt" TIMESTAMP(3),
ADD COLUMN     "ttlSeconds" INTEGER;
