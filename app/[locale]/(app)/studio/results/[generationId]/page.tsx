import Link from 'next/link';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound, redirect } from 'next/navigation';

import { SubmitButton } from '@/components/forms/submit-button';
import {
  ContentIdeasOutput,
  ContentPlanOutput,
  DescriptionOutput,
  ScriptOutput,
  TitlesOutput,
} from '@/domain/ai/types';
import { requireUser } from '@/lib/auth/current-user';
import { localePath } from '@/lib/i18n/paths';
import { getGeneration, saveIdea } from '@/modules/ai/history';

export const dynamic = 'force-dynamic';

export default async function ResultPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; generationId: string }>;
  searchParams: Promise<{ cached?: string }>;
}) {
  const { locale, generationId } = await params;
  const { cached } = await searchParams;
  setRequestLocale(locale);

  const user = await requireUser(locale);
  const result = await getGeneration(user.id, generationId);
  if (!result.ok) notFound();
  const generation = result.data;

  const t = await getTranslations('results');
  const ts = await getTranslations('studio');
  const savedTitles = new Set(generation.ideas.map((idea) => idea.title));
  const inputs = (generation.inputJson ?? {}) as Record<string, unknown>;
  const asked = String(inputs.topic ?? inputs.title ?? inputs.goal ?? '');

  async function save(formData: FormData) {
    'use server';
    const current = await requireUser(locale);
    await saveIdea({
      userId: current.id,
      generationId,
      index: Number(formData.get('index')),
    });
    redirect(localePath(locale, `/studio/results/${generationId}`));
  }

  return (
    <main className="page page--wide">
      <p className="small">
        <Link href={localePath(locale, '/studio')}>← {t('back')}</Link>
      </p>
      <header className="page__header">
        <h1>
          {ts(
            `tools.${generation.feature === 'PLAN' ? 'plan' : generation.feature.toLowerCase()}` as 'tools.ideas',
          )}
        </h1>
        {asked && (
          <p className="muted">
            {t('input')}: “{asked}”
          </p>
        )}
      </header>

      {cached && <p className="flash flash--ok">{t('cached')}</p>}

      {generation.status !== 'OK' ? (
        <section className="card">
          <p>{t('failed')}</p>
          {generation.errorCode && ts.has(`errors.${generation.errorCode}`) && (
            <p className="muted">{ts(`errors.${generation.errorCode}`)}</p>
          )}
        </section>
      ) : (
        <Output
          feature={generation.feature}
          output={generation.outputJson}
          savedTitles={savedTitles}
          save={save}
          t={t}
        />
      )}

      <p className="muted small">{t('model', { model: generation.model })}</p>
    </main>
  );
}

type Translate = Awaited<ReturnType<typeof getTranslations<'results'>>>;

function Output({
  feature,
  output,
  savedTitles,
  save,
  t,
}: {
  feature: string;
  output: unknown;
  savedTitles: Set<string>;
  save: (formData: FormData) => Promise<void>;
  t: Translate;
}) {
  // Stored output is re-validated before rendering: the database is a boundary
  // too, and an older prompt version may have produced a different shape.
  switch (feature) {
    case 'IDEAS': {
      const parsed = ContentIdeasOutput.safeParse(output);
      if (!parsed.success) return <p className="muted">{t('failed')}</p>;
      return (
        <ol className="result-list">
          {parsed.data.ideas.map((idea, index) => (
            <li key={index} className="card">
              <h2 className="result__title">{idea.title}</h2>
              <p className="muted small">{t(`formats.${idea.format}`)}</p>
              <dl className="result__facts">
                <dt>{t('ideas.angle')}</dt>
                <dd>{idea.angle}</dd>
                <dt>{t('ideas.hook')}</dt>
                <dd>{idea.hook}</dd>
                <dt>{t('ideas.keywords')}</dt>
                <dd>{idea.keywords.join(', ')}</dd>
                {idea.rationale && (
                  <>
                    <dt>{t('ideas.why')}</dt>
                    <dd>{idea.rationale}</dd>
                  </>
                )}
              </dl>
              {savedTitles.has(idea.title) ? (
                <p className="flash flash--ok">{t('ideas.saved')}</p>
              ) : (
                <form action={save}>
                  <input type="hidden" name="index" value={index} />
                  <SubmitButton
                    label={t('ideas.save')}
                    pendingLabel={t('ideas.saving')}
                    className="button"
                  />
                </form>
              )}
            </li>
          ))}
        </ol>
      );
    }

    case 'TITLES': {
      const parsed = TitlesOutput.safeParse(output);
      if (!parsed.success) return <p className="muted">{t('failed')}</p>;
      return (
        <section className="card">
          <ol className="result-list result-list--plain">
            {parsed.data.titles.map((title, index) => (
              <li key={index}>
                <p className="result__title">{title.text}</p>
                <p className="muted small">
                  {t(`titleStyles.${title.style}`)} ·{' '}
                  {t('titles.characters', { count: [...title.text].length })} ·{' '}
                  {t('titles.strength', { value: title.estimatedStrength })}
                </p>
                {title.reasoning && <p className="small">{title.reasoning}</p>}
              </li>
            ))}
          </ol>
          <p className="muted small">{t('titles.strengthNote')}</p>
        </section>
      );
    }

    case 'DESCRIPTION': {
      const parsed = DescriptionOutput.safeParse(output);
      if (!parsed.success) return <p className="muted">{t('failed')}</p>;
      return (
        <section className="card">
          <pre className="result__text">{parsed.data.description}</pre>
          {parsed.data.hashtags.length > 0 && (
            <>
              <h2>{t('description.hashtags')}</h2>
              <p>{parsed.data.hashtags.join(' ')}</p>
            </>
          )}
          {parsed.data.chapters && parsed.data.chapters.length > 0 && (
            <>
              <h2>{t('description.chapters')}</h2>
              <pre className="result__text">
                {parsed.data.chapters.map((c) => `${c.timestamp} ${c.label}`).join('\n')}
              </pre>
            </>
          )}
          <p className="muted small">{t('description.copyHint')}</p>
        </section>
      );
    }

    case 'SCRIPT': {
      const parsed = ScriptOutput.safeParse(output);
      if (!parsed.success) return <p className="muted">{t('failed')}</p>;
      return (
        <section className="card">
          <p className="muted small">
            {t('script.duration', {
              minutes: Math.max(1, Math.round(parsed.data.estimatedDurationSeconds / 60)),
            })}
          </p>
          <h2>{t('script.hook')}</h2>
          <p className="result__prose">{parsed.data.hook}</p>
          {parsed.data.sections.map((section, index) => (
            <div key={index}>
              <h2>{section.heading}</h2>
              <p className="result__prose">{section.body}</p>
            </div>
          ))}
          <h2>{t('script.cta')}</h2>
          <p className="result__prose">{parsed.data.callToAction}</p>
        </section>
      );
    }

    case 'PLAN': {
      const parsed = ContentPlanOutput.safeParse(output);
      if (!parsed.success) return <p className="muted">{t('failed')}</p>;
      return (
        <section className="card">
          <p>{parsed.data.summary}</p>
          <p className="muted">
            {t('plan.cadence')}: {parsed.data.cadence}
          </p>
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col" className="num">
                  {t('plan.week')}
                </th>
                <th scope="col">{t('plan.titleCol')}</th>
                <th scope="col">{t('plan.format')}</th>
                <th scope="col">{t('plan.goal')}</th>
              </tr>
            </thead>
            <tbody>
              {parsed.data.entries.map((entry, index) => (
                <tr key={index}>
                  <td className="num">{entry.week}</td>
                  <td>{entry.title}</td>
                  <td>{entry.format}</td>
                  <td>{entry.goal}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      );
    }

    default:
      return null;
  }
}
