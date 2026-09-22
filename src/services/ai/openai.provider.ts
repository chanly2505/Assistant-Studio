import 'server-only';

import type { Logger } from 'pino';
import { z, type ZodTypeAny } from 'zod';

import { FEATURES } from '@/domain/ai/features';
import { OUTPUT_SCHEMA_BY_FEATURE, type AIFeatureName } from '@/domain/ai/types';
import { AppError } from '@/domain/errors/app-error';
import type { SecretString } from '@/domain/shared/secret';
import { logger as rootLogger } from '@/lib/logger';
import { describeShape, errorReason, externalRequest } from '@/services/google/http';

import type {
  AIService,
  CallOptions,
  DescriptionInput,
  IdeasInput,
  PlanInput,
  ProviderResult,
  ScriptInput,
  TitlesInput,
  TokenUsage,
} from './ai-service';
import { JSON_SCHEMAS } from './json-schemas';
import { buildPrompt, type BuiltPrompt } from './prompts';

/**
 * OpenAI Responses API with strict Structured Outputs.
 * Request shape per https://developers.openai.com/api/docs/guides/structured-outputs:
 *   text: { format: { type: "json_schema", name, schema, strict: true } }
 *
 * `store: false`: by default the Responses API keeps application state for
 * 30 days. Creators' drafts do not need to live on OpenAI's servers.
 * (API data is not used for training by default — OpenAI "Your data" docs.)
 */

const RESPONSES_URL = 'https://api.openai.com/v1/responses';

/** Usage a failed call still incurred — attached to the error as its `cause`. */
export interface BilledUsage {
  model: string;
  usage: TokenUsage;
}

export function billedUsageOf(error: unknown): BilledUsage | null {
  const cause = (error as { cause?: unknown } | null)?.cause;
  const billed = (cause as { billed?: BilledUsage } | null | undefined)?.billed;
  return billed && typeof billed.model === 'string' && billed.usage ? billed : null;
}

const ContentItem = z
  .object({ type: z.string(), text: z.string().optional(), refusal: z.string().optional() })
  .passthrough();
const OutputItem = z
  .object({ type: z.string(), content: z.array(ContentItem).optional() })
  .passthrough();

const ResponseBody = z
  .object({
    status: z.string().optional(),
    incomplete_details: z.object({ reason: z.string().optional() }).nullish(),
    error: z.object({ code: z.string().nullish(), message: z.string().nullish() }).nullish(),
    output: z.array(OutputItem).default([]),
    usage: z
      .object({
        input_tokens: z.number().int().nonnegative(),
        input_tokens_details: z
          .object({ cached_tokens: z.number().int().nonnegative() })
          .partial()
          .nullish(),
        output_tokens: z.number().int().nonnegative(),
      })
      .nullish(),
  })
  .passthrough();

export interface OpenAIConfig {
  apiKey: SecretString;
  fastModel: string;
  strongModel: string;
}

export class OpenAIProvider implements AIService {
  constructor(private readonly config: OpenAIConfig) {}

  generateContentIdeas(input: IdeasInput, options?: CallOptions) {
    return this.run('IDEAS', buildPrompt('IDEAS', input), options);
  }
  generateTitles(input: TitlesInput, options?: CallOptions) {
    return this.run('TITLES', buildPrompt('TITLES', input), options);
  }
  generateDescription(input: DescriptionInput, options?: CallOptions) {
    return this.run('DESCRIPTION', buildPrompt('DESCRIPTION', input), options);
  }
  generateScript(input: ScriptInput, options?: CallOptions) {
    return this.run('SCRIPT', buildPrompt('SCRIPT', input), options);
  }
  generateContentPlan(input: PlanInput, options?: CallOptions) {
    return this.run('PLAN', buildPrompt('PLAN', input), options);
  }

  modelFor(feature: AIFeatureName): string {
    return FEATURES[feature].tier === 'strong' ? this.config.strongModel : this.config.fastModel;
  }

  /**
   * One call, validated with Zod. If the JSON fails validation, ONE repair
   * attempt re-asks with the validation errors appended; a second failure is
   * AI_INVALID_OUTPUT. Usage is summed across attempts — both cost money.
   */
  private async run<N extends AIFeatureName>(
    feature: N,
    prompt: BuiltPrompt,
    options: CallOptions = {},
  ): Promise<ProviderResult<z.infer<(typeof OUTPUT_SCHEMA_BY_FEATURE)[N]>>> {
    const log = options.log ?? rootLogger;
    const model = this.modelFor(feature);
    const schema = OUTPUT_SCHEMA_BY_FEATURE[feature] as ZodTypeAny;

    const usage: TokenUsage = {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reported: true,
    };

    let attempt = 0;
    let input = prompt.input;
    for (;;) {
      attempt += 1;
      const call = await this.call(feature, model, prompt.instructions, input, log);
      usage.inputTokens += call.usage.inputTokens;
      usage.cachedInputTokens += call.usage.cachedInputTokens;
      usage.outputTokens += call.usage.outputTokens;
      usage.reported &&= call.usage.reported;

      const parsed = parseJson(call.text);
      const validated = parsed.ok ? schema.safeParse(parsed.value) : null;

      if (validated?.success) {
        return {
          data: validated.data,
          model,
          promptVersion: prompt.promptVersion,
          usage,
          attempts: attempt,
        };
      }

      const problems = validated
        ? validated.error.issues
            .slice(0, 8)
            .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        : ['the response was not valid JSON'];

      if (attempt >= 2) {
        throw new AppError('AI_INVALID_OUTPUT', {
          detail: `${feature} output failed validation after ${attempt} attempts: ${problems.join('; ')}`,
          params: { attempts: attempt },
          // Billed tokens travel with the error so the real cost is recorded.
          cause: { billed: { model, usage } satisfies BilledUsage },
        });
      }

      log.warn(
        { feature, problems: problems.length },
        'AI output failed validation; one repair attempt',
      );
      input = `${prompt.input}

Your previous answer did not match the required format. Problems:
${problems.map((p) => `- ${p}`).join('\n')}
Return corrected JSON only.`;
    }
  }

  private async call(
    feature: AIFeatureName,
    model: string,
    instructions: string,
    input: string,
    log: Logger,
  ): Promise<{ text: string; usage: TokenUsage }> {
    const { name, schema } = JSON_SCHEMAS[feature];
    const response = await externalRequest({
      api: 'openai',
      operation: `responses.create.${feature.toLowerCase()}`,
      url: RESPONSES_URL,
      timeoutMs: FEATURES[feature].tier === 'strong' ? 120_000 : 45_000,
      log,
      init: {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.config.apiKey.expose()}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model,
          instructions,
          input,
          max_output_tokens: FEATURES[feature].maxOutputTokens,
          store: false,
          text: { format: { type: 'json_schema', name, schema, strict: true } },
        }),
      },
    });

    if (!response.ok)
      throw classifyOpenAIError(response.status, response.body, response.retryAfterSeconds);

    const parsed = ResponseBody.safeParse(response.body);
    if (!parsed.success) {
      throw new AppError('AI_UNAVAILABLE', {
        detail: `responses.create returned an unexpected shape ${describeShape(response.body)}`,
      });
    }
    const body = parsed.data;
    const usage: TokenUsage = body.usage
      ? {
          inputTokens: body.usage.input_tokens,
          cachedInputTokens: body.usage.input_tokens_details?.cached_tokens ?? 0,
          outputTokens: body.usage.output_tokens,
          reported: true,
        }
      : { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reported: false };

    const content = body.output.flatMap((item) =>
      item.type === 'message' ? (item.content ?? []) : [],
    );

    // A refusal "does not necessarily follow the schema you have supplied".
    const refusal = content.find((item) => item.type === 'refusal');
    const billed = { billed: { model, usage } satisfies BilledUsage };
    if (refusal || body.incomplete_details?.reason === 'content_filter') {
      throw new AppError('AI_REFUSED', {
        detail: `model declined (${refusal ? 'refusal' : 'content_filter'})`,
        cause: billed,
      });
    }

    if (body.status === 'incomplete') {
      // Usually max_output_tokens: the JSON is truncated and cannot be parsed.
      throw new AppError('AI_INVALID_OUTPUT', {
        detail: `response incomplete: ${body.incomplete_details?.reason ?? 'unknown'}`,
        cause: billed,
      });
    }
    if (body.status === 'failed' || body.error) {
      throw new AppError('AI_UNAVAILABLE', {
        detail: `response failed: ${body.error?.code ?? 'unknown'}`,
      });
    }

    const text = content
      .filter((item) => item.type === 'output_text')
      .map((item) => item.text ?? '')
      .join('');
    return { text, usage };
  }
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/**
 * 401/403 → our key is wrong: AI_UNAVAILABLE, logged at error (someone must act).
 * 429     → rate limit or exhausted credit: AI_UNAVAILABLE, retryable.
 * 400     → OUR request is malformed: INTERNAL, a defect.
 * 5xx     → provider outage: AI_UNAVAILABLE, retryable.
 */
export function classifyOpenAIError(
  status: number,
  body: unknown,
  retryAfterSeconds?: number,
): AppError {
  const reason = errorReason(body) ?? `http_${status}`;
  const retry = retryAfterSeconds ? { retryAfterSeconds } : {};

  if (status === 401 || status === 403) {
    return new AppError('AI_UNAVAILABLE', {
      detail: `openai rejected credentials (${reason}): check OPENAI_API_KEY`,
    });
  }
  if (status === 429) {
    return new AppError('AI_UNAVAILABLE', {
      detail: `openai rate limit or credit (${reason})`,
      ...retry,
    });
  }
  if (status === 400 || status === 422) {
    return new AppError('INTERNAL', { detail: `openai rejected the request (${reason})` });
  }
  return new AppError('AI_UNAVAILABLE', { detail: `openai ${status} (${reason})`, ...retry });
}
