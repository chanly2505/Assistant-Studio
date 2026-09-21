import { describe, expect, it } from 'vitest';

import { AppError } from '@/domain/errors/app-error';
import { SecretString } from '@/domain/shared/secret';
import { getAIService } from '@/services/ai';
import { getYouTubeService } from '@/services/youtube/youtube.service';

/**
 * Phase 2 wires the seams but not the integrations. These tests pin the honest
 * behaviour: an unimplemented feature answers 501, it does not return invented
 * data that makes the UI look finished.
 *
 * When Phase 3/6 land, these tests are replaced by real contract tests against
 * recorded fixtures — the failures here are the reminder.
 */

describe('AI service (Phase 2 placeholder)', () => {
  const ai = getAIService();

  it.each([
    ['generateContentIdeas', () => ai.generateContentIdeas({ locale: 'en', topic: 'coffee' })],
    ['generateTitles', () => ai.generateTitles({ locale: 'en', topic: 'coffee' })],
    [
      'generateDescription',
      () => ai.generateDescription({ locale: 'en', title: 't', summary: 's' }),
    ],
    [
      'generateScript',
      () => ai.generateScript({ locale: 'en', title: 't', targetDurationSeconds: 300 }),
    ],
    ['generateContentPlan', () => ai.generateContentPlan({ locale: 'en', goal: 'g', weeks: 4 })],
  ])('%s reports NOT_IMPLEMENTED rather than returning fixtures', async (_name, call) => {
    await expect(call()).rejects.toMatchObject({ code: 'NOT_IMPLEMENTED', status: 501 });
    await expect(call()).rejects.toBeInstanceOf(AppError);
  });
});

describe('YouTube service (not yet implemented parts)', () => {
  const youtube = getYouTubeService();
  const token = new SecretString('ya29.test', 'accessToken');

  // Channels (Phase 3) and videos (Phase 4) are real and tested against
  // intercepted Google responses in tests/integration/.
  it.each([
    [
      'getChannelAnalytics',
      () => youtube.getChannelAnalytics(token, 'UC1', new Date(), new Date()),
    ],
  ])('%s reports NOT_IMPLEMENTED', async (_name, call) => {
    await expect(call()).rejects.toMatchObject({ code: 'NOT_IMPLEMENTED', status: 501 });
  });
});
