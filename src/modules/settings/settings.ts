import { prisma } from '@/db/prisma';
import { auditRepository } from '@/db/repositories/audit.repository';
import { channelRepository } from '@/db/repositories/channel.repository';
import { isValidTimeZone } from '@/domain/content/time';
import { AppError, notFound, toAppError } from '@/domain/errors/app-error';
import { err, ok, type Result } from '@/domain/errors/result';
import { isAvailableLocale } from '@/lib/i18n/routing';

import type { UpdateChannelSettingsRequest, UpdateUserSettingsRequest } from './inputs';

/**
 * User and channel settings. Every setting here is USED somewhere — nothing
 * is collected for show:
 *   locale           the app's screens (and the language the user returns to)
 *   timezone         schedule and calendar times (modules/content)
 *   contentLanguage  Studio's default language; new projects' language
 *   defaultChannelId Studio's preselected channel
 *   channel settings the AI's channel context (modules/ai/context-builder)
 */

const invalid = (messageKey: string, detail: string) =>
  new AppError('VALIDATION_FAILED', { messageKey, detail });

export async function getUserSettings(userId: string) {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: {
      email: true,
      locale: true,
      timezone: true,
      settings: { select: { contentLanguage: true, defaultChannelId: true } },
    },
  });
  return ok({
    email: user.email,
    locale: user.locale,
    timezone: isValidTimeZone(user.timezone) ? user.timezone : 'UTC',
    contentLanguage: user.settings?.contentLanguage ?? 'en',
    defaultChannelId: user.settings?.defaultChannelId ?? null,
  });
}

export async function updateUserSettings(
  userId: string,
  input: UpdateUserSettingsRequest,
): Promise<Result<{ locale: string }>> {
  try {
    if (input.locale !== undefined && !isAvailableLocale(input.locale)) {
      throw invalid('errors.settings.languageUnavailable', `locale ${input.locale} not served`);
    }
    if (input.timezone !== undefined && !isValidTimeZone(input.timezone)) {
      throw invalid('errors.content.badTimeZone', 'invalid IANA zone');
    }
    if (input.defaultChannelId) {
      const channel = await channelRepository.findForUser(userId, input.defaultChannelId);
      if (!channel) throw notFound('channel');
    }

    const user = await prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id: userId },
        data: {
          ...(input.locale !== undefined ? { locale: input.locale } : {}),
          ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
        },
        select: { locale: true },
      });
      const settings = {
        ...(input.contentLanguage !== undefined ? { contentLanguage: input.contentLanguage } : {}),
        ...(input.defaultChannelId !== undefined
          ? { defaultChannelId: input.defaultChannelId }
          : {}),
      };
      await tx.userSettings.upsert({
        where: { userId },
        update: settings,
        create: { userId, ...settings },
      });
      await auditRepository.record(
        {
          userId,
          action: 'settings.user.updated',
          resourceType: 'User',
          resourceId: userId,
          metadata: { fields: Object.keys(input) },
        },
        tx,
      );
      return updated;
    });
    return ok({ locale: user.locale });
  } catch (thrown) {
    return err(toAppError(thrown));
  }
}

export async function getChannelSettings(userId: string, channelId: string) {
  const channel = await channelRepository.findForUser(userId, channelId);
  if (!channel) return err(notFound('channel'));
  const settings = await prisma.channelSettings.findUnique({ where: { channelId } });
  return ok({
    channel: { id: channel.id, title: channel.title },
    settings: {
      niche: settings?.niche ?? '',
      targetAudience: settings?.targetAudience ?? '',
      brandVoice: settings?.brandVoice ?? '',
      keywords: settings?.keywords ?? [],
    },
  });
}

/** Empty text clears a field; omitted fields are left as they are. */
export async function updateChannelSettings(
  userId: string,
  channelId: string,
  input: UpdateChannelSettingsRequest,
): Promise<Result<{ channelId: string }>> {
  try {
    const channel = await channelRepository.findForUser(userId, channelId);
    if (!channel) throw notFound('channel');

    const text = (value: string | undefined) =>
      value === undefined ? undefined : value.trim() === '' ? null : value.trim();
    const data = {
      ...(input.niche !== undefined ? { niche: text(input.niche) } : {}),
      ...(input.targetAudience !== undefined ? { targetAudience: text(input.targetAudience) } : {}),
      ...(input.brandVoice !== undefined ? { brandVoice: text(input.brandVoice) } : {}),
      // Cleaned here as well as in the request schema: these go into AI prompts.
      ...(input.keywords !== undefined
        ? {
            keywords: [...new Set(input.keywords.map((k) => k.trim()).filter(Boolean))].slice(
              0,
              15,
            ),
          }
        : {}),
    };
    await prisma.channelSettings.upsert({
      where: { channelId },
      update: data,
      create: { channelId, ...data, keywords: data.keywords ?? [] },
    });
    await auditRepository.record({
      userId,
      action: 'settings.channel.updated',
      resourceType: 'YouTubeChannel',
      resourceId: channelId,
      metadata: { fields: Object.keys(input) },
    });
    return ok({ channelId });
  } catch (thrown) {
    return err(toAppError(thrown));
  }
}
