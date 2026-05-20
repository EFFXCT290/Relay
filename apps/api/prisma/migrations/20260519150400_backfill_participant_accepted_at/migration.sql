-- Backfill: any participant rows that existed before the request feature are
-- treated as already-accepted. New rows from the request flow set acceptedAt
-- explicitly (creator gets now(), recipient stays null until they accept).
UPDATE "Participant" SET "acceptedAt" = "joinedAt" WHERE "acceptedAt" IS NULL;
