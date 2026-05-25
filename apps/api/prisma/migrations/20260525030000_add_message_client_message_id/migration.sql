-- AddColumn: clientMessageId (nullable) for idempotent message sends
ALTER TABLE "Message" ADD COLUMN "clientMessageId" TEXT;

-- Compound unique index: (senderId, clientMessageId).
-- NULL values are treated as distinct in PostgreSQL, so existing rows
-- with clientMessageId = NULL do not conflict with each other.
CREATE UNIQUE INDEX "Message_senderId_clientMessageId_key"
  ON "Message"("senderId", "clientMessageId");
