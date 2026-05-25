-- AddColumn: clientUploadId (nullable, unique) for idempotent re-uploads
ALTER TABLE "Media" ADD COLUMN "clientUploadId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Media_clientUploadId_key" ON "Media"("clientUploadId");
