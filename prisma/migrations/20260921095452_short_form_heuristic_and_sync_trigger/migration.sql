-- Hand-edited. Prisma generated DROP COLUMN "isShort" + ADD COLUMN "isShortForm",
-- which silently destroys the data on any database that already has videos.
-- A rename keeps it. (Review every generated migration before applying.)
ALTER TABLE "YouTubeVideo" RENAME COLUMN "isShort" TO "isShortForm";

-- What caused each sync run: connect | manual | schedule.
ALTER TABLE "SyncJob" ADD COLUMN "trigger" TEXT NOT NULL DEFAULT 'schedule';
