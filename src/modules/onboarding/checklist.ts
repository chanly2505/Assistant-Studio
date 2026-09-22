import { prisma } from '@/db/prisma';
import { userRepository } from '@/db/repositories/user.repository';
import { ok } from '@/domain/errors/result';
import { getUsage } from '@/modules/ai/history';
import { MAX_ACTIVE_PROJECTS } from '@/modules/content/projects';

/**
 * "Getting started" for people who have never used a tool like this.
 *
 * Each step is worked out from what the user has actually done, not from a
 * stored "onboarding step" — so it can never claim a step is done when it
 * is not, or nag about one that is. Steps are in the order that makes sense
 * for a creator: connect, describe the channel (which improves every AI
 * result), get ideas, turn one into a project, put it on the calendar.
 */

export const STEPS = [
  'connectChannel',
  'describeChannel',
  'firstIdeas',
  'startProject',
  'scheduleVideo',
] as const;
export type Step = (typeof STEPS)[number];

export interface Progress {
  channels: number;
  describedChannels: number;
  ideasOrGenerations: number;
  projects: number;
  scheduledProjects: number;
}

export function checklistFrom(progress: Progress) {
  const done: Record<Step, boolean> = {
    connectChannel: progress.channels > 0,
    describeChannel: progress.describedChannels > 0,
    firstIdeas: progress.ideasOrGenerations > 0,
    startProject: progress.projects > 0,
    scheduleVideo: progress.scheduledProjects > 0,
  };
  const steps = STEPS.map((step) => ({ step, done: done[step] }));
  const next = steps.find((s) => !s.done)?.step ?? null;
  return { steps, next, completed: steps.filter((s) => s.done).length, total: steps.length };
}

export async function getGettingStarted(userId: string) {
  const liveChannel = { userId, disconnectedAt: null };
  const liveProject = { userId, deletedAt: null };
  const [channels, firstChannel, described, ideas, generations, projects, scheduled] =
    await Promise.all([
      prisma.youTubeChannel.count({ where: liveChannel }),
      prisma.youTubeChannel.findFirst({
        where: liveChannel,
        orderBy: { connectedAt: 'asc' },
        select: { id: true },
      }),
      prisma.channelSettings.count({
        where: {
          channel: liveChannel,
          OR: [{ niche: { not: null } }, { targetAudience: { not: null } }],
        },
      }),
      prisma.contentIdea.count({ where: { userId } }),
      prisma.aIGeneration.count({ where: { userId, status: 'OK' } }),
      prisma.contentProject.count({ where: liveProject }),
      prisma.contentProject.count({
        where: { ...liveProject, OR: [{ scheduledFor: { not: null } }, { status: 'PUBLISHED' }] },
      }),
    ]);

  return ok({
    ...checklistFrom({
      channels,
      describedChannels: described,
      ideasOrGenerations: ideas + generations,
      projects,
      scheduledProjects: scheduled,
    }),
    firstChannelId: firstChannel?.id ?? null,
  });
}

/** What the user has used and what is left, in one place. */
export async function getUsageSummary(userId: string) {
  const [ai, limits, channels, projects] = await Promise.all([
    getUsage(userId),
    userRepository.planLimits(userId),
    prisma.youTubeChannel.count({ where: { userId, disconnectedAt: null } }),
    prisma.contentProject.count({
      where: { userId, deletedAt: null, status: { not: 'ARCHIVED' } },
    }),
  ]);
  return ok({
    ai: ai.ok ? ai.data : null,
    channels: { used: channels, limit: limits.maxChannels },
    projects: { used: projects, limit: MAX_ACTIVE_PROJECTS },
  });
}
