import type { Logger } from 'pino';

import { syncJobRepository } from '@/db/repositories/sync-job.repository';
import { videoRepository } from '@/db/repositories/video.repository';
import { toVideoRecord } from '@/services/youtube/mappers';
import { getYouTubeService } from '@/services/youtube/youtube.service';
import { VIDEOS_PER_REQUEST } from '@/services/youtube/youtube-data.client';

import { runSyncJob, type SyncContext, type SyncTrigger } from './run-sync-job';

/**
 * Enumerates a channel's videos through its uploads playlist.
 * docs/architecture/06-youtube-integration-architecture.md §6.3
 *
 * Cost: 1 unit per 50 playlist entries + 1 unit per 50 videos fetched.
 * A 500-video channel costs ~20 units for a full walk — search.list would cost
 * 1,000+.
 *
 *   full  — every page. Afterwards, videos we hold that the playlist no longer
 *           lists are marked deleted. Weekly, and on first connect.
 *   delta — newest first; stops at the first video already stored. Daily.
 *           Typically 1 playlist call + 1 videos call.
 *
 * Each page is fetched AND stored before the next is requested, so a failure
 * halfway (quota, network) keeps everything already written, and the next run
 * continues from there.
 */

export type WalkMode = 'full' | 'delta';

/** Safety stop: 400 pages = 20,000 uploads, well past any channel we serve. */
export const MAX_PLAYLIST_PAGES = 400;

export interface VideoSyncResult {
  mode: WalkMode;
  pages: number;
  seen: number;
  created: number;
  updated: number;
  markedDeleted: number;
  /** False when the walk stopped at MAX_PLAYLIST_PAGES; deletions are then not inferred. */
  complete: boolean;
}

export async function syncChannelVideos(params: {
  userId: string;
  channelId: string;
  mode: WalkMode;
  trigger: SyncTrigger;
  attempt?: number;
  log?: Logger;
}) {
  const jobType =
    params.mode === 'delta'
      ? 'VIDEO_DELTA'
      : params.trigger === 'connect'
        ? 'CHANNEL_BACKFILL'
        : 'VIDEO_FULL';

  return runSyncJob({ ...params, jobType, tracksChannelStatus: true }, async (context) => {
    const result = await walk(context, params.mode);
    // Only a complete full walk counts: it is what deletion detection and the
    // weekly schedule are keyed on.
    if (params.mode === 'full' && result.complete) {
      await syncJobRepository.recordFullSync(context.channel.id, context.now);
    }
    return result;
  });
}

async function walk(context: SyncContext, mode: WalkMode): Promise<VideoSyncResult> {
  const youtube = getYouTubeService();
  const { channel, token, log, now } = context;

  const seen = new Set<string>();
  const result: VideoSyncResult = {
    mode,
    pages: 0,
    seen: 0,
    created: 0,
    updated: 0,
    markedDeleted: 0,
    complete: false,
  };

  let pageToken: string | null = null;
  let reachedKnown = false;

  while (result.pages < MAX_PLAYLIST_PAGES) {
    await context.spend('playlistItems.list');
    const page = await youtube.listPlaylistPage(token, channel.uploadsPlaylistId, pageToken, log);
    result.pages += 1;

    let ids = page.videoIds;
    if (mode === 'delta') {
      const known = await videoRepository.knownIds(channel.id, ids);
      const firstKnown = ids.findIndex((id) => known.has(id));
      if (firstKnown !== -1) {
        ids = ids.slice(0, firstKnown);
        reachedKnown = true;
      }
    }

    for (const id of ids) seen.add(id);
    await fetchAndStore(context, ids, result);

    if (reachedKnown || !page.nextPageToken) {
      result.complete = true;
      break;
    }
    pageToken = page.nextPageToken;
  }

  if (!result.complete) {
    log.warn({ pages: result.pages }, 'playlist walk hit the page cap; deletions not inferred');
  }

  // Only a COMPLETE full walk proves absence. A capped or delta walk has not
  // seen every video, so it must never mark anything deleted.
  if (mode === 'full' && result.complete) {
    const gone = (await videoRepository.liveIds(channel.id)).filter((id) => !seen.has(id));
    result.markedDeleted += await videoRepository.markDeleted(channel.id, gone, now);
  }

  result.seen = seen.size;
  return result;
}

/** videos.list in batches of 50; ids YouTube does not return are unavailable. */
async function fetchAndStore(
  context: SyncContext,
  ids: string[],
  result: VideoSyncResult,
): Promise<void> {
  const youtube = getYouTubeService();
  const { channel, token, log, now } = context;

  for (let offset = 0; offset < ids.length; offset += VIDEOS_PER_REQUEST) {
    const batch = ids.slice(offset, offset + VIDEOS_PER_REQUEST);

    await context.spend('videos.list');
    const raw = await youtube.listVideos(token, batch, log);

    const records = raw.map((video) => toVideoRecord(video, now));
    const { created, updated } = await videoRepository.upsertWithStats(channel.id, records, now);
    result.created += created;
    result.updated += updated;
    context.addItems(records.length);

    // Listed in the playlist but not returned: deleted, or blocked by YouTube.
    const returned = new Set(raw.map((video) => video.id));
    const missing = batch.filter((id) => !returned.has(id));
    result.markedDeleted += await videoRepository.markDeleted(channel.id, missing, now);
  }
}
