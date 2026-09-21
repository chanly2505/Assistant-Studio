-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'DELETED');

-- CreateEnum
CREATE TYPE "ConnectionStatus" AS ENUM ('ACTIVE', 'REAUTH_REQUIRED', 'REVOKED');

-- CreateEnum
CREATE TYPE "ChannelSyncStatus" AS ENUM ('NEVER_SYNCED', 'QUEUED', 'SYNCING', 'SYNCED', 'FAILED', 'PAUSED');

-- CreateEnum
CREATE TYPE "SyncTier" AS ENUM ('HOT', 'WARM', 'COLD');

-- CreateEnum
CREATE TYPE "VideoPrivacyStatus" AS ENUM ('PUBLIC', 'UNLISTED', 'PRIVATE');

-- CreateEnum
CREATE TYPE "ContentSource" AS ENUM ('AI', 'USER');

-- CreateEnum
CREATE TYPE "IdeaStatus" AS ENUM ('SAVED', 'PROMOTED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ProjectStatus" AS ENUM ('IDEA', 'SCRIPTING', 'FILMING', 'EDITING', 'SCHEDULED', 'PUBLISHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "AssetKind" AS ENUM ('TITLE', 'DESCRIPTION', 'SCRIPT', 'TAGS', 'THUMBNAIL_BRIEF', 'CHAPTERS');

-- CreateEnum
CREATE TYPE "CalendarEntryType" AS ENUM ('REMINDER', 'TASK', 'NOTE');

-- CreateEnum
CREATE TYPE "CalendarEntryStatus" AS ENUM ('PENDING', 'DONE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AIFeature" AS ENUM ('IDEAS', 'TITLES', 'DESCRIPTION', 'SCRIPT', 'PLAN');

-- CreateEnum
CREATE TYPE "AIGenerationStatus" AS ENUM ('PENDING', 'OK', 'INVALID_OUTPUT', 'PROVIDER_ERROR', 'TIMEOUT', 'FILTERED');

-- CreateEnum
CREATE TYPE "ExternalApi" AS ENUM ('YOUTUBE_DATA', 'YOUTUBE_ANALYTICS', 'OPENAI');

-- CreateEnum
CREATE TYPE "SyncJobType" AS ENUM ('CHANNEL_BACKFILL', 'CHANNEL_STATS', 'VIDEO_DELTA', 'VIDEO_FULL', 'VIDEO_STATS', 'ANALYTICS');

-- CreateEnum
CREATE TYPE "SyncJobStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('USER', 'SYSTEM', 'WORKER');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "emailVerified" TIMESTAMP(3),
    "name" TEXT,
    "image" TEXT,
    "locale" TEXT NOT NULL DEFAULT 'en',
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "planKey" TEXT NOT NULL DEFAULT 'free',
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerAccountId" TEXT NOT NULL,
    "refresh_token" TEXT,
    "access_token" TEXT,
    "expires_at" INTEGER,
    "token_type" TEXT,
    "scope" TEXT,
    "id_token" TEXT,
    "session_state" TEXT,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "sessionToken" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VerificationToken" (
    "identifier" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL
);

-- CreateTable
CREATE TABLE "UserSettings" (
    "userId" TEXT NOT NULL,
    "defaultChannelId" TEXT,
    "contentLanguage" TEXT NOT NULL DEFAULT 'en',
    "brandVoice" TEXT,
    "emailDigest" BOOLEAN NOT NULL DEFAULT true,
    "onboardingStep" TEXT NOT NULL DEFAULT 'connect_channel',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserSettings_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "Plan" (
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "maxChannels" INTEGER NOT NULL DEFAULT 1,
    "monthlyGenerations" JSONB NOT NULL,
    "features" JSONB NOT NULL DEFAULT '{}',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Plan_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "OAuthState" (
    "state" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "codeVerifier" TEXT NOT NULL,
    "redirectTo" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OAuthState_pkey" PRIMARY KEY ("state")
);

-- CreateTable
CREATE TABLE "YouTubeConnection" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "googleSub" TEXT NOT NULL,
    "googleEmail" TEXT NOT NULL,
    "encryptedRefreshToken" TEXT NOT NULL,
    "encryptionKeyVersion" INTEGER NOT NULL DEFAULT 1,
    "scopes" TEXT[],
    "status" "ConnectionStatus" NOT NULL DEFAULT 'ACTIVE',
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastRefreshedAt" TIMESTAMP(3),
    "lastRefreshError" TEXT,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "YouTubeConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "YouTubeChannel" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "youtubeChannelId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "handle" TEXT,
    "description" TEXT,
    "thumbnailUrl" TEXT,
    "country" TEXT,
    "uploadsPlaylistId" TEXT NOT NULL,
    "publishedAt" TIMESTAMP(3),
    "syncStatus" "ChannelSyncStatus" NOT NULL DEFAULT 'NEVER_SYNCED',
    "lastFullSyncAt" TIMESTAMP(3),
    "lastStatsSyncAt" TIMESTAMP(3),
    "lastAnalyticsDate" DATE,
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "disconnectedAt" TIMESTAMP(3),

    CONSTRAINT "YouTubeChannel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChannelSettings" (
    "channelId" TEXT NOT NULL,
    "niche" TEXT,
    "targetAudience" TEXT,
    "brandVoice" TEXT,
    "keywords" TEXT[],
    "contentLanguage" TEXT NOT NULL DEFAULT 'en',
    "uploadCadence" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChannelSettings_pkey" PRIMARY KEY ("channelId")
);

-- CreateTable
CREATE TABLE "ChannelStatsSnapshot" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "subscriberCount" BIGINT NOT NULL,
    "viewCount" BIGINT NOT NULL,
    "videoCount" INTEGER NOT NULL,
    "subscriberCountIsRounded" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "ChannelStatsSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "YouTubeVideo" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "youtubeVideoId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "publishedAt" TIMESTAMP(3) NOT NULL,
    "durationSeconds" INTEGER NOT NULL,
    "privacyStatus" "VideoPrivacyStatus" NOT NULL DEFAULT 'PUBLIC',
    "thumbnailUrl" TEXT,
    "tags" TEXT[],
    "categoryId" TEXT,
    "defaultLanguage" TEXT,
    "isShort" BOOLEAN NOT NULL DEFAULT false,
    "syncTier" "SyncTier" NOT NULL DEFAULT 'HOT',
    "lastStatsSyncAt" TIMESTAMP(3),
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedFromYouTubeAt" TIMESTAMP(3),

    CONSTRAINT "YouTubeVideo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VideoStatsSnapshot" (
    "id" TEXT NOT NULL,
    "videoId" TEXT NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "viewCount" BIGINT NOT NULL,
    "likeCount" BIGINT,
    "commentCount" BIGINT,

    CONSTRAINT "VideoStatsSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChannelAnalyticsDaily" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "views" BIGINT NOT NULL DEFAULT 0,
    "estimatedMinutesWatched" BIGINT NOT NULL DEFAULT 0,
    "averageViewDuration" INTEGER NOT NULL DEFAULT 0,
    "subscribersGained" INTEGER NOT NULL DEFAULT 0,
    "subscribersLost" INTEGER NOT NULL DEFAULT 0,
    "likes" INTEGER NOT NULL DEFAULT 0,
    "comments" INTEGER NOT NULL DEFAULT 0,
    "shares" INTEGER NOT NULL DEFAULT 0,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isProvisional" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "ChannelAnalyticsDaily_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VideoAnalyticsDaily" (
    "id" TEXT NOT NULL,
    "videoId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "views" BIGINT NOT NULL DEFAULT 0,
    "estimatedMinutesWatched" BIGINT NOT NULL DEFAULT 0,
    "averageViewDuration" INTEGER NOT NULL DEFAULT 0,
    "averageViewPercentage" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "likes" INTEGER NOT NULL DEFAULT 0,
    "comments" INTEGER NOT NULL DEFAULT 0,
    "shares" INTEGER NOT NULL DEFAULT 0,
    "subscribersGained" INTEGER NOT NULL DEFAULT 0,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isProvisional" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "VideoAnalyticsDaily_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContentIdea" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "channelId" TEXT,
    "title" TEXT NOT NULL,
    "angle" TEXT,
    "hook" TEXT,
    "format" TEXT,
    "keywords" TEXT[],
    "rationale" TEXT,
    "source" "ContentSource" NOT NULL DEFAULT 'AI',
    "aiGenerationId" TEXT,
    "status" "IdeaStatus" NOT NULL DEFAULT 'SAVED',
    "projectId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "ContentIdea_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContentProject" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "channelId" TEXT,
    "title" TEXT NOT NULL,
    "locale" TEXT NOT NULL DEFAULT 'en',
    "status" "ProjectStatus" NOT NULL DEFAULT 'IDEA',
    "scheduledFor" TIMESTAMP(3),
    "publishedAt" TIMESTAMP(3),
    "publishedVideoId" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "ContentProject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContentAsset" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "kind" "AssetKind" NOT NULL,
    "locale" TEXT NOT NULL DEFAULT 'en',
    "body" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "isSelected" BOOLEAN NOT NULL DEFAULT false,
    "aiGenerationId" TEXT,
    "createdBy" "ContentSource" NOT NULL DEFAULT 'AI',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContentAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContentStatusEvent" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "fromStatus" "ProjectStatus",
    "toStatus" "ProjectStatus" NOT NULL,
    "changedByUserId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContentStatusEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CalendarEntry" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "channelId" TEXT,
    "projectId" TEXT,
    "title" TEXT NOT NULL,
    "entryType" "CalendarEntryType" NOT NULL DEFAULT 'TASK',
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3),
    "allDay" BOOLEAN NOT NULL DEFAULT false,
    "status" "CalendarEntryStatus" NOT NULL DEFAULT 'PENDING',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CalendarEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AIGeneration" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "channelId" TEXT,
    "projectId" TEXT,
    "feature" "AIFeature" NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "locale" TEXT NOT NULL DEFAULT 'en',
    "inputHash" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "costMicros" BIGINT NOT NULL DEFAULT 0,
    "latencyMs" INTEGER,
    "status" "AIGenerationStatus" NOT NULL DEFAULT 'PENDING',
    "errorCode" TEXT,
    "outputJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "AIGeneration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UsageCounter" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "periodStart" DATE NOT NULL,
    "feature" "AIFeature" NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "tokensUsed" INTEGER NOT NULL DEFAULT 0,
    "costMicros" BIGINT NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UsageCounter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiQuotaLedger" (
    "id" TEXT NOT NULL,
    "api" "ExternalApi" NOT NULL,
    "day" DATE NOT NULL,
    "unitsUsed" BIGINT NOT NULL DEFAULT 0,
    "requestCount" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApiQuotaLedger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncJob" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "jobType" "SyncJobType" NOT NULL,
    "status" "SyncJobStatus" NOT NULL DEFAULT 'QUEUED',
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "itemsProcessed" INTEGER NOT NULL DEFAULT 0,
    "quotaUnitsUsed" INTEGER NOT NULL DEFAULT 0,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SyncJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "actorType" "ActorType" NOT NULL DEFAULT 'USER',
    "action" TEXT NOT NULL,
    "resourceType" TEXT,
    "resourceId" TEXT,
    "ipHash" TEXT,
    "userAgent" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_status_deletedAt_idx" ON "User"("status", "deletedAt");

-- CreateIndex
CREATE INDEX "User_planKey_idx" ON "User"("planKey");

-- CreateIndex
CREATE INDEX "Account_userId_idx" ON "Account"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Account_provider_providerAccountId_key" ON "Account"("provider", "providerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "Session_sessionToken_key" ON "Session"("sessionToken");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Session_expires_idx" ON "Session"("expires");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationToken_token_key" ON "VerificationToken"("token");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationToken_identifier_token_key" ON "VerificationToken"("identifier", "token");

-- CreateIndex
CREATE INDEX "OAuthState_expiresAt_idx" ON "OAuthState"("expiresAt");

-- CreateIndex
CREATE INDEX "YouTubeConnection_status_idx" ON "YouTubeConnection"("status");

-- CreateIndex
CREATE UNIQUE INDEX "YouTubeConnection_userId_googleSub_key" ON "YouTubeConnection"("userId", "googleSub");

-- CreateIndex
CREATE UNIQUE INDEX "YouTubeChannel_youtubeChannelId_key" ON "YouTubeChannel"("youtubeChannelId");

-- CreateIndex
CREATE INDEX "YouTubeChannel_userId_disconnectedAt_idx" ON "YouTubeChannel"("userId", "disconnectedAt");

-- CreateIndex
CREATE INDEX "YouTubeChannel_connectionId_idx" ON "YouTubeChannel"("connectionId");

-- CreateIndex
CREATE INDEX "YouTubeChannel_syncStatus_idx" ON "YouTubeChannel"("syncStatus");

-- CreateIndex
CREATE INDEX "ChannelStatsSnapshot_channelId_capturedAt_idx" ON "ChannelStatsSnapshot"("channelId", "capturedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "YouTubeVideo_youtubeVideoId_key" ON "YouTubeVideo"("youtubeVideoId");

-- CreateIndex
CREATE INDEX "YouTubeVideo_channelId_publishedAt_idx" ON "YouTubeVideo"("channelId", "publishedAt" DESC);

-- CreateIndex
CREATE INDEX "YouTubeVideo_channelId_syncTier_lastStatsSyncAt_idx" ON "YouTubeVideo"("channelId", "syncTier", "lastStatsSyncAt");

-- CreateIndex
CREATE INDEX "VideoStatsSnapshot_videoId_capturedAt_idx" ON "VideoStatsSnapshot"("videoId", "capturedAt" DESC);

-- CreateIndex
CREATE INDEX "ChannelAnalyticsDaily_channelId_date_idx" ON "ChannelAnalyticsDaily"("channelId", "date" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "ChannelAnalyticsDaily_channelId_date_key" ON "ChannelAnalyticsDaily"("channelId", "date");

-- CreateIndex
CREATE INDEX "VideoAnalyticsDaily_videoId_date_idx" ON "VideoAnalyticsDaily"("videoId", "date" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "VideoAnalyticsDaily_videoId_date_key" ON "VideoAnalyticsDaily"("videoId", "date");

-- CreateIndex
CREATE INDEX "ContentIdea_userId_status_createdAt_idx" ON "ContentIdea"("userId", "status", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "ContentIdea_channelId_idx" ON "ContentIdea"("channelId");

-- CreateIndex
CREATE INDEX "ContentIdea_projectId_idx" ON "ContentIdea"("projectId");

-- CreateIndex
CREATE INDEX "ContentIdea_aiGenerationId_idx" ON "ContentIdea"("aiGenerationId");

-- CreateIndex
CREATE INDEX "ContentProject_userId_status_updatedAt_idx" ON "ContentProject"("userId", "status", "updatedAt" DESC);

-- CreateIndex
CREATE INDEX "ContentProject_userId_scheduledFor_idx" ON "ContentProject"("userId", "scheduledFor");

-- CreateIndex
CREATE INDEX "ContentProject_channelId_idx" ON "ContentProject"("channelId");

-- CreateIndex
CREATE INDEX "ContentProject_publishedVideoId_idx" ON "ContentProject"("publishedVideoId");

-- CreateIndex
CREATE INDEX "ContentAsset_projectId_kind_isSelected_idx" ON "ContentAsset"("projectId", "kind", "isSelected");

-- CreateIndex
CREATE INDEX "ContentAsset_aiGenerationId_idx" ON "ContentAsset"("aiGenerationId");

-- CreateIndex
CREATE UNIQUE INDEX "ContentAsset_projectId_kind_locale_version_key" ON "ContentAsset"("projectId", "kind", "locale", "version");

-- CreateIndex
CREATE INDEX "ContentStatusEvent_projectId_createdAt_idx" ON "ContentStatusEvent"("projectId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "CalendarEntry_userId_startsAt_idx" ON "CalendarEntry"("userId", "startsAt");

-- CreateIndex
CREATE INDEX "CalendarEntry_channelId_idx" ON "CalendarEntry"("channelId");

-- CreateIndex
CREATE INDEX "CalendarEntry_projectId_idx" ON "CalendarEntry"("projectId");

-- CreateIndex
CREATE INDEX "AIGeneration_userId_createdAt_idx" ON "AIGeneration"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AIGeneration_userId_feature_inputHash_idx" ON "AIGeneration"("userId", "feature", "inputHash");

-- CreateIndex
CREATE INDEX "AIGeneration_status_createdAt_idx" ON "AIGeneration"("status", "createdAt");

-- CreateIndex
CREATE INDEX "AIGeneration_channelId_idx" ON "AIGeneration"("channelId");

-- CreateIndex
CREATE INDEX "AIGeneration_projectId_idx" ON "AIGeneration"("projectId");

-- CreateIndex
CREATE INDEX "UsageCounter_periodStart_idx" ON "UsageCounter"("periodStart");

-- CreateIndex
CREATE UNIQUE INDEX "UsageCounter_userId_periodStart_feature_key" ON "UsageCounter"("userId", "periodStart", "feature");

-- CreateIndex
CREATE UNIQUE INDEX "ApiQuotaLedger_api_day_key" ON "ApiQuotaLedger"("api", "day");

-- CreateIndex
CREATE INDEX "SyncJob_channelId_jobType_createdAt_idx" ON "SyncJob"("channelId", "jobType", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "SyncJob_status_createdAt_idx" ON "SyncJob"("status", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_userId_createdAt_idx" ON "AuditLog"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AuditLog_action_createdAt_idx" ON "AuditLog"("action", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AuditLog_resourceType_resourceId_idx" ON "AuditLog"("resourceType", "resourceId");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_planKey_fkey" FOREIGN KEY ("planKey") REFERENCES "Plan"("key") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserSettings" ADD CONSTRAINT "UserSettings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OAuthState" ADD CONSTRAINT "OAuthState_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "YouTubeConnection" ADD CONSTRAINT "YouTubeConnection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "YouTubeChannel" ADD CONSTRAINT "YouTubeChannel_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "YouTubeConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "YouTubeChannel" ADD CONSTRAINT "YouTubeChannel_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelSettings" ADD CONSTRAINT "ChannelSettings_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "YouTubeChannel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelStatsSnapshot" ADD CONSTRAINT "ChannelStatsSnapshot_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "YouTubeChannel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "YouTubeVideo" ADD CONSTRAINT "YouTubeVideo_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "YouTubeChannel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VideoStatsSnapshot" ADD CONSTRAINT "VideoStatsSnapshot_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "YouTubeVideo"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelAnalyticsDaily" ADD CONSTRAINT "ChannelAnalyticsDaily_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "YouTubeChannel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VideoAnalyticsDaily" ADD CONSTRAINT "VideoAnalyticsDaily_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "YouTubeVideo"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentIdea" ADD CONSTRAINT "ContentIdea_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentIdea" ADD CONSTRAINT "ContentIdea_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "YouTubeChannel"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentIdea" ADD CONSTRAINT "ContentIdea_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "ContentProject"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentIdea" ADD CONSTRAINT "ContentIdea_aiGenerationId_fkey" FOREIGN KEY ("aiGenerationId") REFERENCES "AIGeneration"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentProject" ADD CONSTRAINT "ContentProject_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentProject" ADD CONSTRAINT "ContentProject_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "YouTubeChannel"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentProject" ADD CONSTRAINT "ContentProject_publishedVideoId_fkey" FOREIGN KEY ("publishedVideoId") REFERENCES "YouTubeVideo"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentAsset" ADD CONSTRAINT "ContentAsset_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "ContentProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentAsset" ADD CONSTRAINT "ContentAsset_aiGenerationId_fkey" FOREIGN KEY ("aiGenerationId") REFERENCES "AIGeneration"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentStatusEvent" ADD CONSTRAINT "ContentStatusEvent_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "ContentProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalendarEntry" ADD CONSTRAINT "CalendarEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalendarEntry" ADD CONSTRAINT "CalendarEntry_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "YouTubeChannel"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalendarEntry" ADD CONSTRAINT "CalendarEntry_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "ContentProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AIGeneration" ADD CONSTRAINT "AIGeneration_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AIGeneration" ADD CONSTRAINT "AIGeneration_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "YouTubeChannel"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AIGeneration" ADD CONSTRAINT "AIGeneration_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "ContentProject"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsageCounter" ADD CONSTRAINT "UsageCounter_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SyncJob" ADD CONSTRAINT "SyncJob_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "YouTubeChannel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
