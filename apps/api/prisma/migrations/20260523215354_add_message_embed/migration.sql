-- CreateTable
CREATE TABLE "MessageEmbed" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "title" TEXT,
    "description" TEXT,
    "imageUrl" TEXT,
    "siteName" TEXT,
    "faviconUrl" TEXT,
    "type" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MessageEmbed_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MessageEmbed_messageId_key" ON "MessageEmbed"("messageId");

-- AddForeignKey
ALTER TABLE "MessageEmbed" ADD CONSTRAINT "MessageEmbed_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;
