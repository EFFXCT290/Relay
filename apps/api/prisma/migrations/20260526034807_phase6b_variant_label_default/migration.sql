/*
  Warnings:

  - Made the column `label` on table `MediaVariant` required. This step will fail if there are existing NULL values in that column.

*/
-- AlterTable
ALTER TABLE "MediaVariant" ALTER COLUMN "label" SET NOT NULL,
ALTER COLUMN "label" SET DEFAULT '';
