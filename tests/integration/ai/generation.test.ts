import { HttpResponse, delay, http } from 'msw';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { FEATURES, allowancePeriodStart } from '@/domain/ai/features';
import { generateIdeas, generateScript, generateTitles } from '@/modules/ai/generate';
import { getUsage, saveIdea } from '@/modules/ai/history';
import { sweepAbandonedGenerations } from '@/modules/ai/run-generation';
import { setAIService } from '@/services/ai';
import { maxCostMicros } from '@/services/ai/pricing';

import {
  createTestChannel,
  createTestUser,
  disconnectDatabase,
  resetDatabase,
  testPrisma,
} from '../../helpers/db';
import {
  OPENAI_URL,
  callsTo,
  googleServer,
  openai,
  openaiRequests,
  resetGoogle,
  resetOpenAI,
  validOutputs,
} from '../../helpers/google';

beforeAll(() => googleServer.listen({ onUnhandledRequest: 'error' }));
beforeEach(async () => {
  await resetDatabase();
  resetOpenAI();
  setAIService(undefined); // rebuilt from env on first use
});
afterEach(() => resetGoogle());
afterAll(async () => {
  googleServer.close();
  await disconnectDatabase();
});

async function userWithLimits(
  limits: Record<string, number> = { IDEAS: 50, TITLES: 50, DESCRIPTION: 25, SCRIPT: 5, PLAN: 5 },
) {
  await testPrisma.plan.upsert({
    where: { key: 'test-plan' },
    update: { monthlyGenerations: limits },
    create: { key: 'test-plan', name: 'Test', maxChannels: 3, monthlyGenerations: limits },
  });
  return createTestUser({ planKey: 'test-plan' });
}

async function usedThisMonth(userId: string, feature: 'IDEAS' | 'TITLES' | 'SCRIPT') {
  const row = await testPrisma.usageCounter.findUnique({
    where: {
      userId_periodStart_feature: {
        userId,
        periodStart: allowancePeriodStart(new Date()),
        feature,
      },
    },
  });
  return row?.count ?? 0;
}

describe('happy path', () => {
  it('returns validated output and records tokens, cost, allowance and audit', async () => {
    const user = await userWithLimits();
    googleServer.use(
      openai([{ kind: 'json', value: validOutputs.IDEAS, usage: { input: 1_000, output: 500 } }]),
    );

    const result = await generateIdeas(
      { userId: user.id },
      { topic: 'breakfast stalls', count: 3, locale: 'en' },
    );
    if (!result.ok) throw result.error;

    expect(result.data.data.ideas).toHaveLength(3);
    expect(result.data).toMatchObject({ cached: false, model: 'gpt-5.6-luna', remaining: 49 });

    const generation = await testPrisma.aIGeneration.findUniqueOrThrow({
      where: { id: result.data.generationId },
    });
    expect(generation).toMatchObject({
      status: 'OK',
      feature: 'IDEAS',
      model: 'gpt-5.6-luna',
      promptVersion: 'ideas.v1',
      inputTokens: 1_000,
      outputTokens: 500,
      costMicros: 800n, // 1,000 × $0.20/M + 500 × $1.20/M
      costKnown: true,
    });
    expect(generation.inputJson).toEqual({ topic: 'breakfast stalls', count: 3 });
    expect(await usedThisMonth(user.id, 'IDEAS')).toBe(1);
    expect(await testPrisma.auditLog.count({ where: { action: 'ai.ideas.generated' } })).toBe(1);
  });

  it('sends a strict structured-output request with store:false and delimited user text', async () => {
    const user = await userWithLimits();
    googleServer.use(openai([{ kind: 'json', value: validOutputs.TITLES }]));
    await generateTitles({ userId: user.id }, { topic: 'num banh chok', locale: 'km' });

    const body = openaiRequests[0] as Record<string, any>;
    expect(body.model).toBe('gpt-5.6-luna');
    expect(body.store).toBe(false);
    expect(body.max_output_tokens).toBe(1_500);
    expect(body.text.format).toMatchObject({
      type: 'json_schema',
      name: 'video_titles',
      strict: true,
    });
    expect(body.input).toContain('<user_input>num banh chok</user_input>');
    expect(body.instructions).toMatch(/Khmer/);
  });

  it('routes scripts to the strong model', async () => {
    const user = await userWithLimits();
    googleServer.use(openai([{ kind: 'json', value: validOutputs.SCRIPT }]));
    const result = await generateScript(
      { userId: user.id },
      { title: 'Market morning', targetMinutes: 8, locale: 'en' },
    );
    if (!result.ok) throw result.error;
    expect((openaiRequests[0] as { model: string }).model).toBe('gpt-5.6-sol');
  });
});

describe('invalid output and failures', () => {
  it('repairs once when the first answer is invalid, and bills both attempts', async () => {
    const user = await userWithLimits();
    googleServer.use(
      openai([
        { kind: 'text', text: 'not json at all', usage: { input: 1_000, output: 100 } },
        { kind: 'json', value: validOutputs.IDEAS, usage: { input: 1_200, output: 500 } },
      ]),
    );

    const result = await generateIdeas(
      { userId: user.id },
      { topic: 'x-ray of a noodle stall', count: 3, locale: 'en' },
    );
    if (!result.ok) throw result.error;

    expect(callsTo(OPENAI_URL)).toHaveLength(2);
    expect((openaiRequests[1] as { input: string }).input).toContain(
      'did not match the required format',
    );
    const generation = await testPrisma.aIGeneration.findUniqueOrThrow({
      where: { id: result.data.generationId },
    });
    expect(generation).toMatchObject({ inputTokens: 2_200, outputTokens: 600 });
  });

  it('gives up after the repair fails: INVALID_OUTPUT, allowance refunded, real cost kept', async () => {
    const user = await userWithLimits();
    const bad = { ideas: [{ title: 'x' }] };
    googleServer.use(openai([{ kind: 'json', value: bad, usage: { input: 1_000, output: 100 } }]));

    const result = await generateIdeas(
      { userId: user.id },
      { topic: 'topic here', count: 3, locale: 'en' },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('AI_INVALID_OUTPUT');

    const generation = await testPrisma.aIGeneration.findFirstOrThrow();
    expect(generation).toMatchObject({
      status: 'INVALID_OUTPUT',
      inputTokens: 2_000,
      outputTokens: 200,
      costKnown: true,
    });
    expect(generation.costMicros).toBe(640n); // 2,000 × 0.20 + 200 × 1.20
    expect(await usedThisMonth(user.id, 'IDEAS')).toBe(0);
  });

  it('treats a refusal as FILTERED, refunds the allowance and records the billed cost', async () => {
    const user = await userWithLimits();
    googleServer.use(openai([{ kind: 'refusal' }]));

    const result = await generateIdeas(
      { userId: user.id },
      { topic: 'something declined', count: 3, locale: 'en' },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('AI_REFUSED');

    const generation = await testPrisma.aIGeneration.findFirstOrThrow();
    expect(generation).toMatchObject({ status: 'FILTERED', inputTokens: 800, outputTokens: 20 });
    expect(await usedThisMonth(user.id, 'IDEAS')).toBe(0);
  });

  it('treats a truncated answer (max_output_tokens) as invalid output', async () => {
    const user = await userWithLimits();
    googleServer.use(openai([{ kind: 'incomplete', reason: 'max_output_tokens' }]));
    const result = await generateIdeas(
      { userId: user.id },
      { topic: 'long topic', count: 3, locale: 'en' },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('AI_INVALID_OUTPUT');
    expect(await usedThisMonth(user.id, 'IDEAS')).toBe(0);
  });

  it.each([
    [429, 'rate limit or exhausted credit'],
    [500, 'provider outage'],
    [401, 'bad key'],
  ])('maps HTTP %i (%s) to AI_UNAVAILABLE with nothing billed', async (status) => {
    const user = await userWithLimits();
    googleServer.use(openai([{ kind: 'http', status }]));

    const result = await generateIdeas(
      { userId: user.id },
      { topic: `topic ${status}`, count: 3, locale: 'en' },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('AI_UNAVAILABLE');

    const generation = await testPrisma.aIGeneration.findFirstOrThrow();
    expect(generation).toMatchObject({ status: 'PROVIDER_ERROR', costMicros: 0n });
    expect(await usedThisMonth(user.id, 'IDEAS')).toBe(0);
  });
});

describe('allowance, cache and spend limits', () => {
  it('refuses at the monthly limit WITHOUT calling the provider', async () => {
    const user = await userWithLimits({ IDEAS: 1 });
    googleServer.use(openai([{ kind: 'json', value: validOutputs.IDEAS }]));

    await generateIdeas({ userId: user.id }, { topic: 'first topic', count: 3, locale: 'en' });
    const second = await generateIdeas(
      { userId: user.id },
      { topic: 'second topic', count: 3, locale: 'en' },
    );

    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error.code).toBe('AI_LIMIT_REACHED');
      expect(second.error.params.resetAt).toMatch(/^\d{4}-\d{2}-01T00:00:00/);
    }
    expect(callsTo(OPENAI_URL)).toHaveLength(1);
  });

  it('admits exactly the limit under concurrency', async () => {
    const user = await userWithLimits({ IDEAS: 5 });
    googleServer.use(openai([{ kind: 'json', value: validOutputs.IDEAS }]));

    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        generateIdeas(
          { userId: user.id },
          { topic: `distinct topic ${i}`, count: 3, locale: 'en' },
        ),
      ),
    );

    expect(results.filter((r) => r.ok)).toHaveLength(5);
    expect(callsTo(OPENAI_URL)).toHaveLength(5);
    expect(await usedThisMonth(user.id, 'IDEAS')).toBe(5);
  });

  it('answers an identical request from cache: no call, no allowance', async () => {
    const user = await userWithLimits();
    googleServer.use(openai([{ kind: 'json', value: validOutputs.IDEAS }]));
    const request = { topic: 'same topic', count: 3, locale: 'en' as const };

    const first = await generateIdeas({ userId: user.id }, request);
    const second = await generateIdeas({ userId: user.id }, { ...request, topic: 'same topic' });
    if (!first.ok || !second.ok) throw new Error('expected success');

    expect(second.data).toMatchObject({ cached: true, generationId: first.data.generationId });
    expect(callsTo(OPENAI_URL)).toHaveLength(1);
    expect(await usedThisMonth(user.id, 'IDEAS')).toBe(1);
  });

  it('never shares cached results between users', async () => {
    const alice = await userWithLimits();
    const bob = await userWithLimits();
    googleServer.use(openai([{ kind: 'json', value: validOutputs.IDEAS }]));
    const request = { topic: 'shared topic', count: 3, locale: 'en' as const };

    await generateIdeas({ userId: alice.id }, request);
    const bobs = await generateIdeas({ userId: bob.id }, request);
    if (!bobs.ok) throw bobs.error;
    expect(bobs.data.cached).toBe(false);
  });

  it('stops all generation at the daily platform spend limit', async () => {
    const user = await userWithLimits();
    await testPrisma.aIGeneration.create({
      data: {
        userId: user.id,
        feature: 'SCRIPT',
        provider: 'openai',
        model: 'gpt-5.6-sol',
        promptVersion: 'script.v1',
        inputHash: 'x',
        status: 'OK',
        costMicros: 50_000_000n, // = AI_DAILY_SPEND_LIMIT_MICROS default ($50)
      },
    });
    googleServer.use(openai([{ kind: 'json', value: validOutputs.IDEAS }]));

    const result = await generateIdeas(
      { userId: user.id },
      { topic: 'after the cap', count: 3, locale: 'en' },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('AI_UNAVAILABLE');
    expect(callsTo(OPENAI_URL)).toHaveLength(0);
    expect(await usedThisMonth(user.id, 'IDEAS')).toBe(0);
  });

  // Load-tested: a burst of simultaneous requests must not overshoot the daily
  // cap. Each in-flight call reserves its worst-case cost before it starts, so
  // with room for exactly three worst-case calls, exactly three go ahead.
  it('holds the daily spend cap under a burst of simultaneous requests', async () => {
    const worstCase = maxCostMicros('gpt-5.6-luna', FEATURES.IDEAS.maxOutputTokens);
    const roomFor = 3;
    const seed = await userWithLimits();
    await testPrisma.aIGeneration.create({
      data: {
        userId: seed.id,
        feature: 'SCRIPT',
        provider: 'openai',
        model: 'gpt-5.6-sol',
        promptVersion: 'script.v1',
        inputHash: 'already-spent',
        status: 'OK',
        costMicros: BigInt(50_000_000 - worstCase * roomFor - 1),
      },
    });
    // A slow provider keeps all twenty in flight at once. (A fast one lets
    // early finishers swap their worst-case reservation for the real, lower
    // cost and free budget for later requests — correct, but it would hide
    // whether the reservation itself holds.)
    googleServer.use(
      http.post(OPENAI_URL, async () => {
        await delay(400);
        return HttpResponse.json({
          status: 'completed',
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: JSON.stringify(validOutputs.IDEAS) }],
            },
          ],
          usage: {
            input_tokens: 1_000,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens: 500,
            total_tokens: 1_500,
          },
        });
      }),
    );

    // Twenty different users, so no one's monthly allowance is what stops them.
    const users = await Promise.all(Array.from({ length: 20 }, () => userWithLimits()));
    const results = await Promise.all(
      users.map((u, i) =>
        generateIdeas({ userId: u.id }, { topic: `burst number ${i}`, count: 3, locale: 'en' }),
      ),
    );

    const succeeded = results.filter((r) => r.ok);
    expect(succeeded).toHaveLength(roomFor);
    expect(
      results.filter((r) => !r.ok).every((r) => !r.ok && r.error.code === 'AI_UNAVAILABLE'),
    ).toBe(true);
    expect(callsTo(OPENAI_URL)).toHaveLength(roomFor);
    // Refused requests used no allowance.
    const counted = await Promise.all(users.map((u) => usedThisMonth(u.id, 'IDEAS')));
    expect(counted.reduce((a, b) => a + b, 0)).toBe(roomFor);
    const spent = await testPrisma.aIGeneration.aggregate({ _sum: { costMicros: true } });
    expect(Number(spent._sum.costMicros)).toBeLessThanOrEqual(50_000_000);
  });

  it('reports usage per feature', async () => {
    const user = await userWithLimits({ IDEAS: 10, TITLES: 3 });
    googleServer.use(openai([{ kind: 'json', value: validOutputs.IDEAS }]));
    await generateIdeas({ userId: user.id }, { topic: 'counting', count: 3, locale: 'en' });

    const usage = await getUsage(user.id);
    if (!usage.ok) throw usage.error;
    expect(usage.data.features.find((f) => f.feature === 'IDEAS')).toEqual({
      feature: 'IDEAS',
      limit: 10,
      used: 1,
      remaining: 9,
    });
    expect(usage.data.features.find((f) => f.feature === 'SCRIPT')?.limit).toBe(0);
  });
});

describe('channel context', () => {
  it('sends derived, relative figures — never ids, raw counts or descriptions', async () => {
    const user = await userWithLimits();
    const channel = await createTestChannel(user.id);
    // The real connect flow creates this row; the test helper does not.
    await testPrisma.channelSettings.upsert({
      where: { channelId: channel.id },
      update: { niche: 'Cambodian street food', targetAudience: 'Travellers' },
      create: {
        channelId: channel.id,
        niche: 'Cambodian street food',
        targetAudience: 'Travellers',
      },
    });
    for (const [i, views] of [1_000, 2_000, 9_000, 3_000].entries()) {
      const v = await testPrisma.youTubeVideo.create({
        data: {
          channelId: channel.id,
          youtubeVideoId: `vid-secret-${i}`,
          title: `Video ${i}`,
          description: 'PRIVATE-DESCRIPTION-TEXT',
          publishedAt: new Date(Date.now() - (i + 1) * 86_400_000),
          durationSeconds: 600,
        },
      });
      await testPrisma.videoStatsSnapshot.create({
        data: { videoId: v.id, viewCount: BigInt(views) },
      });
    }
    googleServer.use(openai([{ kind: 'json', value: validOutputs.IDEAS }]));

    await generateIdeas(
      { userId: user.id },
      { topic: 'context test', count: 3, locale: 'en', channelId: channel.id },
    );

    const sent = JSON.stringify(openaiRequests[0]);
    expect(sent).toContain('Cambodian street food');
    expect(sent).toContain('3.6×'); // 9,000 / median 2,500
    expect(sent).not.toContain('vid-secret');
    expect(sent).not.toContain(channel.youtubeChannelId);
    expect(sent).not.toContain('PRIVATE-DESCRIPTION-TEXT');
    expect(sent).not.toContain('9000');
  });

  it('refuses another user’s channel before calling the provider', async () => {
    const user = await userWithLimits();
    const stranger = await userWithLimits();
    const channel = await createTestChannel(stranger.id);

    const result = await generateIdeas(
      { userId: user.id },
      { topic: 'foreign channel', count: 3, locale: 'en', channelId: channel.id },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('NOT_FOUND');
    expect(callsTo(OPENAI_URL)).toHaveLength(0);
  });
});

describe('abandoned generations and saving ideas', () => {
  it('sweeps PENDING rows from a crashed process and refunds their allowance', async () => {
    const user = await userWithLimits();
    const periodStart = allowancePeriodStart(new Date());
    await testPrisma.usageCounter.create({
      data: { userId: user.id, periodStart, feature: 'IDEAS', count: 1 },
    });
    await testPrisma.aIGeneration.create({
      data: {
        userId: user.id,
        feature: 'IDEAS',
        provider: 'openai',
        model: 'gpt-5.6-luna',
        promptVersion: 'ideas.v1',
        inputHash: 'h',
        status: 'PENDING',
        createdAt: new Date(Date.now() - 60 * 60_000),
      },
    });

    expect(await sweepAbandonedGenerations()).toBe(1);
    expect(await usedThisMonth(user.id, 'IDEAS')).toBe(0);
    expect((await testPrisma.aIGeneration.findFirstOrThrow()).status).toBe('PROVIDER_ERROR');
    expect(await sweepAbandonedGenerations()).toBe(0); // idempotent
  });

  it('saves an idea from the STORED output, once', async () => {
    const user = await userWithLimits();
    googleServer.use(openai([{ kind: 'json', value: validOutputs.IDEAS }]));
    const result = await generateIdeas(
      { userId: user.id },
      { topic: 'to save', count: 3, locale: 'en' },
    );
    if (!result.ok) throw result.error;

    const saved = await saveIdea({
      userId: user.id,
      generationId: result.data.generationId,
      index: 1,
    });
    const again = await saveIdea({
      userId: user.id,
      generationId: result.data.generationId,
      index: 1,
    });
    if (!saved.ok || !again.ok) throw new Error('expected success');

    expect(again.data).toEqual({ ideaId: saved.data.ideaId, alreadySaved: true });
    const idea = await testPrisma.contentIdea.findUniqueOrThrow({
      where: { id: saved.data.ideaId },
    });
    expect(idea).toMatchObject({
      title: 'Idea number 2',
      source: 'AI',
      aiGenerationId: result.data.generationId,
      userId: user.id,
    });
  });

  it('refuses to save from another user’s generation or a missing index', async () => {
    const user = await userWithLimits();
    const stranger = await userWithLimits();
    googleServer.use(openai([{ kind: 'json', value: validOutputs.IDEAS }]));
    const result = await generateIdeas(
      { userId: user.id },
      { topic: 'mine', count: 3, locale: 'en' },
    );
    if (!result.ok) throw result.error;

    const foreign = await saveIdea({
      userId: stranger.id,
      generationId: result.data.generationId,
      index: 0,
    });
    const outOfRange = await saveIdea({
      userId: user.id,
      generationId: result.data.generationId,
      index: 9,
    });
    expect(foreign.ok).toBe(false);
    expect(outOfRange.ok).toBe(false);
    expect(await testPrisma.contentIdea.count()).toBe(0);
  });
});
