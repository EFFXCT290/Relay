-- CreateTable
CREATE TABLE "TemporaryMedia" (
    "id" TEXT NOT NULL,
    "mediaId" TEXT NOT NULL,
    "maxViews" INTEGER NOT NULL,
    "viewCount" INTEGER NOT NULL DEFAULT 0,
    "consumedAt" TIMESTAMP(3),
    "purgedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TemporaryMedia_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TemporaryMedia_mediaId_key" ON "TemporaryMedia"("mediaId");

-- CreateIndex
CREATE INDEX "TemporaryMedia_consumedAt_purgedAt_idx" ON "TemporaryMedia"("consumedAt", "purgedAt");

-- AddForeignKey
ALTER TABLE "TemporaryMedia" ADD CONSTRAINT "TemporaryMedia_mediaId_fkey" FOREIGN KEY ("mediaId") REFERENCES "Media"("id") ON DELETE CASCADE ON UPDATE CASCADE;
