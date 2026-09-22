import Link from 'next/link';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { redirect } from 'next/navigation';

import { Field } from '@/components/forms/field';
import { SubmitButton } from '@/components/forms/submit-button';
import {
  BOARD_STATUSES,
  PROJECT_STATUSES,
  nextStatus,
  type ProjectStatus,
} from '@/domain/content/status';
import { ErrorFlash } from '@/app/[locale]/_components/error-flash';
import { requireUser } from '@/lib/auth/current-user';
import { localePath } from '@/lib/i18n/paths';
import { CreateProjectRequest } from '@/modules/content/inputs';
import { createProject, listProjects, updateProject } from '@/modules/content/projects';
import { userTimeZone } from '@/modules/content/shared';

export const dynamic = 'force-dynamic';

export default async function ProjectsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ archived?: string; error?: string }>;
}) {
  const { locale } = await params;
  const query = await searchParams;
  setRequestLocale(locale);

  const user = await requireUser(locale);
  const archived = query.archived === '1';
  const t = await getTranslations('projects');
  const ts = await getTranslations('content.statuses');
  const [result, zone] = await Promise.all([
    listProjects(user.id, { archived }),
    userTimeZone(user.id),
  ]);
  const { projects, archivedCount } = result.ok ? result.data : { projects: [], archivedCount: 0 };
  const date = new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: zone,
  });

  async function create(formData: FormData) {
    'use server';
    const current = await requireUser(locale);
    const parsed = CreateProjectRequest.safeParse({ title: formData.get('title') });
    if (!parsed.success) redirect(localePath(locale, '/projects?error=errors.validationFailed'));
    const created = await createProject(current.id, parsed.data);
    if (!created.ok) redirect(localePath(locale, `/projects?error=${created.error.messageKey}`));
    redirect(localePath(locale, `/projects/${created.data.projectId}`));
  }

  async function move(formData: FormData) {
    'use server';
    const current = await requireUser(locale);
    const projectId = String(formData.get('projectId') ?? '');
    const status = String(formData.get('status') ?? '');
    if (!(PROJECT_STATUSES as readonly string[]).includes(status))
      redirect(localePath(locale, '/projects'));
    const moved = await updateProject(current.id, projectId, { status: status as ProjectStatus });
    if (!moved.ok) {
      // A schedule date is set on the project page, so send the user there.
      if (moved.error.messageKey === 'errors.content.needsScheduleDate') {
        redirect(localePath(locale, `/projects/${projectId}?error=${moved.error.messageKey}`));
      }
      redirect(localePath(locale, `/projects?error=${moved.error.messageKey}`));
    }
    redirect(localePath(locale, '/projects'));
  }

  const byStatus = new Map<string, typeof projects>();
  for (const project of projects) {
    byStatus.set(project.status, [...(byStatus.get(project.status) ?? []), project]);
  }

  const card = (project: (typeof projects)[number]) => {
    const next = nextStatus(project.status as ProjectStatus);
    return (
      <li key={project.id} className="board__card">
        <Link href={localePath(locale, `/projects/${project.id}`)} className="board__title">
          {project.title}
        </Link>
        <p className="muted small">
          {project.channel?.title ? `${project.channel.title} · ` : ''}
          {t('assets', { count: project._count.assets })}
        </p>
        {project.scheduledFor && (
          <p className="small">{t('scheduledFor', { date: date.format(project.scheduledFor) })}</p>
        )}
        {!archived && next && (
          <form action={move}>
            <input type="hidden" name="projectId" value={project.id} />
            <input type="hidden" name="status" value={next} />
            <button type="submit" className="button button--quiet small">
              {t('next', { status: ts(next) })} →
            </button>
          </form>
        )}
        <form action={move} className="board__move">
          <input type="hidden" name="projectId" value={project.id} />
          <label className="visually-hidden" htmlFor={`move-${project.id}`}>
            {t('moveTo')}
          </label>
          <select id={`move-${project.id}`} name="status" defaultValue={project.status}>
            {PROJECT_STATUSES.map((status) => (
              <option key={status} value={status}>
                {ts(status)}
              </option>
            ))}
          </select>
          <button type="submit" className="button button--quiet small">
            {t('move')}
          </button>
        </form>
      </li>
    );
  };

  return (
    <main className="page page--full">
      <header className="page__header">
        <h1>{archived ? t('archivedTitle') : t('title')}</h1>
        <p className="muted">{t('subtitle')}</p>
      </header>

      <ErrorFlash error={query.error} />

      {!archived && (
        <section className="card">
          <form action={create} className="form form--inline">
            <Field label={t('new.title')}>
              <input name="title" required maxLength={150} />
            </Field>
            <SubmitButton label={t('new.submit')} pendingLabel={t('new.submitting')} />
          </form>
        </section>
      )}

      {archived ? (
        <>
          <p>
            <Link href={localePath(locale, '/projects')}>← {t('activeLink')}</Link>
          </p>
          {projects.length === 0 ? (
            <p className="muted">{t('column.empty')}</p>
          ) : (
            <ul className="board__list board__list--flat">{projects.map(card)}</ul>
          )}
        </>
      ) : projects.length === 0 ? (
        <p className="muted">{t('empty')}</p>
      ) : (
        <div className="board">
          {BOARD_STATUSES.map((status) => {
            const column = byStatus.get(status) ?? [];
            return (
              <section key={status} className="board__column" aria-labelledby={`col-${status}`}>
                <h2 id={`col-${status}`} className="board__heading">
                  {ts(status)} <span className="muted">{column.length}</span>
                </h2>
                {column.length === 0 ? (
                  <p className="muted small">{t('column.empty')}</p>
                ) : (
                  <ul className="board__list">{column.map(card)}</ul>
                )}
              </section>
            );
          })}
        </div>
      )}

      {!archived && archivedCount > 0 && (
        <p className="small">
          <Link href={localePath(locale, '/projects?archived=1')}>
            {t('archivedLink', { count: archivedCount })}
          </Link>
        </p>
      )}
    </main>
  );
}
