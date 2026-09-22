import Link from 'next/link';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { redirect } from 'next/navigation';

import { Field } from '@/components/forms/field';
import { SubmitButton } from '@/components/forms/submit-button';
import { ErrorFlash } from '@/app/[locale]/_components/error-flash';
import { guardAction } from '@/lib/api/action-guard';
import { requireUser } from '@/lib/auth/current-user';
import { localePath } from '@/lib/i18n/paths';
import { createIdea, deleteIdea, listIdeas, setIdeaStatus } from '@/modules/content/ideas';
import { CreateIdeaRequest } from '@/modules/content/inputs';
import { promoteIdea } from '@/modules/content/projects';

export const dynamic = 'force-dynamic';

const TABS = ['SAVED', 'PROMOTED', 'ARCHIVED'] as const;
type Tab = (typeof TABS)[number];

export default async function IdeasPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ tab?: string; error?: string }>;
}) {
  const { locale } = await params;
  const query = await searchParams;
  setRequestLocale(locale);

  const user = await requireUser(locale);
  const tab: Tab = (TABS as readonly string[]).includes(query.tab ?? '')
    ? (query.tab as Tab)
    : 'SAVED';
  const t = await getTranslations('ideas');
  const result = await listIdeas(user.id, tab);
  const { ideas, counts } = result.ok ? result.data : { ideas: [], counts: {} };

  async function add(formData: FormData) {
    'use server';
    const current = await requireUser(locale);
    if (!(await guardAction(`user:${current.id}`)))
      redirect(localePath(locale, '/ideas?error=errors.tooManyActions'));
    const parsed = CreateIdeaRequest.safeParse({
      title: formData.get('title'),
      angle: formData.get('angle') || undefined,
      hook: formData.get('hook') || undefined,
      keywords: formData.get('keywords') || undefined,
    });
    if (!parsed.success) redirect(localePath(locale, '/ideas?error=errors.validationFailed'));
    const created = await createIdea(current.id, parsed.data);
    if (!created.ok) redirect(localePath(locale, `/ideas?error=${created.error.messageKey}`));
    redirect(localePath(locale, '/ideas'));
  }

  async function act(formData: FormData) {
    'use server';
    const current = await requireUser(locale);
    if (!(await guardAction(`user:${current.id}`)))
      redirect(localePath(locale, '/ideas?error=errors.tooManyActions'));
    const ideaId = String(formData.get('ideaId') ?? '');
    const action = String(formData.get('action') ?? '');
    const back = localePath(locale, `/ideas?tab=${tab}`);

    if (action === 'promote') {
      const promoted = await promoteIdea(current.id, ideaId);
      if (!promoted.ok) redirect(`${back}&error=${promoted.error.messageKey}`);
      redirect(localePath(locale, `/projects/${promoted.data.projectId}`));
    }
    const outcome =
      action === 'archive'
        ? await setIdeaStatus(current.id, ideaId, 'ARCHIVED')
        : action === 'restore'
          ? await setIdeaStatus(current.id, ideaId, 'SAVED')
          : action === 'delete'
            ? await deleteIdea(current.id, ideaId)
            : null;
    if (outcome && !outcome.ok) redirect(`${back}&error=${outcome.error.messageKey}`);
    redirect(back);
  }

  return (
    <main className="page page--wide">
      <header className="page__header">
        <h1>{t('title')}</h1>
        <p className="muted">{t('subtitle')}</p>
      </header>

      <ErrorFlash error={query.error} />

      <section className="card">
        <h2>{t('add.heading')}</h2>
        <form action={add} className="form">
          <Field label={t('add.title')}>
            <input name="title" required maxLength={150} />
          </Field>
          <div className="form__row">
            <Field label={t('add.angle')}>
              <input name="angle" maxLength={400} />
            </Field>
            <Field label={t('add.hook')}>
              <input name="hook" maxLength={200} />
            </Field>
          </div>
          <Field label={t('add.keywords')} hint={t('add.keywordsHint')}>
            <input name="keywords" maxLength={450} />
          </Field>
          <div className="form__actions">
            <SubmitButton label={t('add.submit')} pendingLabel={t('add.submitting')} />
          </div>
        </form>
      </section>

      <nav className="segmented" aria-label={t('title')}>
        {TABS.map((option) => (
          <Link
            key={option}
            href={localePath(locale, `/ideas?tab=${option}`)}
            className={option === tab ? 'segmented__item is-active' : 'segmented__item'}
            aria-current={option === tab ? 'page' : undefined}
          >
            {t(`tabs.${option}`)} ({counts[option] ?? 0})
          </Link>
        ))}
      </nav>

      {ideas.length === 0 ? (
        <section className="card">
          <p>{t('empty')}</p>
          <p className="muted">
            {t('emptyHint')}{' '}
            <Link href={localePath(locale, '/studio?tool=ideas')}>{t('studioLink')}</Link>
          </p>
        </section>
      ) : (
        <ul className="result-list">
          {ideas.map((idea) => (
            <li key={idea.id} className="card">
              <h2 className="result__title">{idea.title}</h2>
              <p className="muted small">
                {idea.source === 'AI' ? t('fromAi') : t('yours')}
                {idea.channel ? ` · ${idea.channel.title}` : ''}
                {idea.format ? ` · ${idea.format}` : ''}
              </p>
              {(idea.angle || idea.hook) && (
                <dl className="result__facts">
                  {idea.angle && (
                    <>
                      <dt>{t('add.angle')}</dt>
                      <dd>{idea.angle}</dd>
                    </>
                  )}
                  {idea.hook && (
                    <>
                      <dt>{t('add.hook')}</dt>
                      <dd>{idea.hook}</dd>
                    </>
                  )}
                </dl>
              )}
              {idea.keywords.length > 0 && <p className="small">{idea.keywords.join(', ')}</p>}

              <div className="actions-row">
                {idea.status === 'PROMOTED' && idea.project && !idea.project.deletedAt ? (
                  <Link
                    className="button"
                    href={localePath(locale, `/projects/${idea.project.id}`)}
                  >
                    {t('openProject')}
                  </Link>
                ) : (
                  <form action={act}>
                    <input type="hidden" name="ideaId" value={idea.id} />
                    <input type="hidden" name="action" value="promote" />
                    <SubmitButton label={t('startProject')} pendingLabel={t('starting')} />
                  </form>
                )}
                {idea.status !== 'PROMOTED' && (
                  <>
                    <form action={act}>
                      <input type="hidden" name="ideaId" value={idea.id} />
                      <input
                        type="hidden"
                        name="action"
                        value={idea.status === 'ARCHIVED' ? 'restore' : 'archive'}
                      />
                      <button type="submit" className="button button--quiet">
                        {idea.status === 'ARCHIVED' ? t('restore') : t('archive')}
                      </button>
                    </form>
                    {idea.status === 'ARCHIVED' && (
                      <form action={act}>
                        <input type="hidden" name="ideaId" value={idea.id} />
                        <input type="hidden" name="action" value="delete" />
                        <button type="submit" className="button button--quiet">
                          {t('delete')}
                        </button>
                      </form>
                    )}
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
