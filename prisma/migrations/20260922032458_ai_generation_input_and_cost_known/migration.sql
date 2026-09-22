-- AlterTable
ALTER TABLE "AIGeneration" ADD COLUMN     "costKnown" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "inputJson" JSONB;
