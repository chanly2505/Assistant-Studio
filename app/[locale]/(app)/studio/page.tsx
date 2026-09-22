import Link from 'next/link';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { redirect } from 'next/navigation';

import { SubmitButton } from '@/components/forms/submit-button';
import { SUPPORTED_LOCALES } from '@/domain/ai/types';
import { requireUser } from '@/lib/auth/current-user';
import { LOCALE_LABELS } from '@/lib/i18n/routing';
import { localePath } from '@/lib/i18n/paths';
import { listChannels } from '@/modules/channels/list-channels';
import {
  FEATURE_BY_SLUG,
  generateDescription,
  generateIdeas,
  generatePlan,
  generateScript,
  generateTitles,
} from '@/modules/ai/generate';
import { getUsage, listGenerations } from '@/modules/ai/history';
import {
  DescriptionRequest,
  IdeasRequest,
  PlanRequest,
  ScriptRequest,
  TitlesRequest,
} from '@/modules/ai/inputs';

export const dynamic = 'force-dynamic';
// A strong-model generation can run long; keep the action alive for it.
export const maxDuration = 120;

const TOOLS = ['ideas', 'titles', 'description', 'script', 'plan'] as const;
type Tool = (typeof TOOLS)[number];

/** Form fields → a plain object. Empty strings become "not provided". */
function fieldsOf(formData: FormData): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const [key, value] of formData.entries()) {
    if (key === 'tool' || key.startsWith('$ACTION')) continue;
    if (typeof value === 'string' && value.trim() !== '') fields[key] = value;
  }
  if (formData.get('includeChapters') === 'on') fields.includeChapters = true;
  return fields;
}

export default async function StudioPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ tool?: string; error?: string }>;
}) {
  const { locale } = await params;
  const query = await searchParams;
  setRequestLocale(locale);

  const user = await requireUser(locale);
  const tool: Tool = (TOOLS as readonly string[]).includes(query.tool ?? '')
    ? (query.tool as Tool)
    : 'ideas';

  const t = await getTranslations('studio');
  const [channels, usage, history] = await Promise.all([
    listChannels({ userId: user.id }),
    getUsage(user.id),
    listGenerations(user.id, 10),
  ]);
  const channelList = channels.ok ? channels.data.channels : [];
  const toolUsage = usage.ok
    ? usage.data.features.find((f) => f.feature === FEATURE_BY_SLUG[tool])
    : undefined;
  const resetDate = usage.ok
    ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(
        new Date(usage.data.resetsAt),
      )
    : '';
  const dateTime = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });

  async function generate(formData: FormData) {
    'use server';
    const current = await requireUser(locale);
    const selected = String(formData.get('tool') ?? '') as Tool;
    const fields = fieldsOf(formData);
    const caller = { userId: current.id };

    const parsers = {
      ideas: () => IdeasRequest.safeParse(fields),
      titles: () => TitlesRequest.safeParse(fields),
      description: () => DescriptionRequest.safeParse(fields),
      script: () => ScriptRequest.safeParse(fields),
      plan: () => PlanRequest.safeParse(fields),
    } as const;
    if (!(selected in parsers)) redirect(localePath(locale, '/studio'));

    const parsed = parsers[selected]();
    if (!parsed.success) {
      redirect(localePath(locale, `/studio?tool=${selected}&error=VALIDATION_FAILED`));
    }

    const run = {
      ideas: () => generateIdeas(caller, parsed.data as IdeasRequest),
      titles: () => generateTitles(caller, parsed.data as TitlesRequest),
      description: () => generateDescription(caller, parsed.data as DescriptionRequest),
      script: () => generateScript(caller, parsed.data as ScriptRequest),
      plan: () => generatePlan(caller, parsed.data as PlanRequest),
    } as const;

    const result = await run[selected]();
    // redirect() throws by design, so it is called after the work, never in a try.
    if (!result.ok) {
      redirect(
        localePath(
          locale,
          `/studio?tool=${selected}&error=${encodeURIComponent(result.error.code)}`,
        ),
      );
    }
    redirect(
      localePath(
        locale,
        `/studio/results/${result.data.generationId}${result.data.cached ? '?cached=1' : ''}`,
      ),
    );
  }

  const errorText = query.error
    ? t.has(`errors.${query.error}`)
      ? t(`errors.${query.error}`)
      : t('errors.generic')
    : null;
  const exhausted = toolUsage ? toolUsage.remaining === 0 : false;

  return (
    <main className="page page--wide">
      <header className="page__header">
        <h1>{t('title')}</h1>
        <p className="muted">{t('subtitle')}</p>
      </header>

      <nav className="segmented" aria-label={t('title')}>
        {TOOLS.map((option) => (
          <Link
            key={option}
            href={localePath(locale, `/studio?tool=${option}`)}
            className={option === tool ? 'segmented__item is-active' : 'segmented__item'}
            aria-current={option === tool ? 'page' : undefined}
          >
            {t(`tools.${option}`)}
          </Link>
        ))}
      </nav>

      {errorText && (
        <p className="flash flash--bad" role="alert">
          {errorText}
        </p>
      )}

      <section className="card">
        <form action={generate} className="form">
          <input type="hidden" name="tool" value={tool} />

          {tool === 'ideas' && (
            <>
              <Field label={t('fields.topic')} hint={t('fields.topicHint')}>
                <input name="topic" required minLength={3} maxLength={300} />
              </Field>
              <Field label={t('fields.count')}>
                <input name="count" type="number" min={3} max={10} defaultValue={6} />
              </Field>
            </>
          )}

          {tool === 'titles' && (
            <>
              <Field label={t('fields.topic')} hint={t('fields.topicHint')}>
                <textarea name="topic" required minLength={3} maxLength={500} rows={3} />
              </Field>
              <Field label={t('fields.existingTitle')}>
                <input name="existingTitle" maxLength={100} />
              </Field>
            </>
          )}

          {tool === 'description' && (
            <>
              <Field label={t('fields.title')}>
                <input name="title" required minLength={3} maxLength={100} />
              </Field>
              <Field label={t('fields.summary')}>
                <textarea name="summary" required minLength={3} maxLength={2000} rows={5} />
              </Field>
              <label className="form__check">
                <input type="checkbox" name="includeChapters" /> {t('fields.includeChapters')}
              </label>
            </>
          )}

          {tool === 'script' && (
            <>
              <Field label={t('fields.title')}>
                <input name="title" required minLength={3} maxLength={100} />
              </Field>
              <Field label={t('fields.outline')}>
                <textarea name="outline" maxLength={3000} rows={5} />
              </Field>
              <Field label={t('fields.targetMinutes')}>
                <input name="targetMinutes" type="number" min={1} max={30} defaultValue={8} />
              </Field>
            </>
          )}

          {tool === 'plan' && (
            <>
              <Field label={t('fields.goal')} hint={t('fields.goalHint')}>
                <textarea name="goal" required minLength={3} maxLength={500} rows={3} />
              </Field>
              <Field label={t('fields.weeks')}>
                <input name="weeks" type="number" min={1} max={12} defaultValue={4} />
              </Field>
            </>
          )}

          <div className="form__row">
            <Field
              label={t('fields.channel')}
              hint={channelList.length ? t('channelNote') : undefined}
            >
              <select name="channelId" defaultValue={channelList[0]?.id ?? ''}>
                <option value="">{t('fields.noChannel')}</option>
                {channelList.map((channel) => (
                  <option key={channel.id} value={channel.id}>
                    {channel.title}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('fields.language')} hint={t('languageNote')}>
              <select name="locale" defaultValue="en">
                {SUPPORTED_LOCALES.map((code) => (
                  <option key={code} value={code}>
                    {LOCALE_LABELS[code]}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <div className="form__actions">
            <SubmitButton label={t('generate')} pendingLabel={t('generating')} />
            {toolUsage && (
              <p className="muted small">
                {exhausted
                  ? t('noneLeft', { date: resetDate })
                  : t('remaining', {
                      remaining: toolUsage.remaining,
                      limit: toolUsage.limit,
                      date: resetDate,
                    })}
              </p>
            )}
          </div>
        </form>
      </section>

      <section className="card">
        <h2>{t('history')}</h2>
        {history.ok && history.data.length > 0 ? (
          <ul className="history">
            {history.data.map((item) => {
              const inputs = (item.inputJson ?? {}) as Record<string, unknown>;
              const summary = String(inputs.topic ?? inputs.title ?? inputs.goal ?? '');
              return (
                <li key={item.id}>
                  <Link href={localePath(locale, `/studio/results/${item.id}`)}>
                    {t(`tools.${slugOf(item.feature)}`)} · {summary}
                  </Link>
                  <span className="muted small">
                    {' '}
                    {t(`status.${item.status as 'OK'}`)} · {dateTime.format(item.createdAt)}
                  </span>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="muted">{t('historyEmpty')}</p>
        )}
      </section>
    </main>
  );
}

function slugOf(feature: string): Tool {
  return (Object.entries(FEATURE_BY_SLUG).find(([, value]) => value === feature)?.[0] ??
    'ideas') as Tool;
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string | undefined;
  children: React.ReactNode;
}) {
  return (
    <label className="form__field">
      <span className="form__label">{label}</span>
      {children}
      {hint && <span className="form__hint">{hint}</span>}
    </label>
  );
}
