import Link from 'next/link';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound, redirect } from 'next/navigation';

import { Field } from '@/components/forms/field';
import { SubmitButton } from '@/components/forms/submit-button';
import { TimeZonePrompt } from '@/components/forms/time-zone-prompt';
import { SUPPORTED_LOCALES } from '@/domain/ai/types';
import { ASSET_KINDS, ASSET_MAX_CHARS, charCount, type AssetKind } from '@/domain/content/assets';
import { PROJECT_STATUSES, type ProjectStatus } from '@/domain/content/status';
import { toLocalDateTimeInput } from '@/domain/content/time';
import { ErrorFlash } from '@/app/[locale]/_components/error-flash';
import { guardAction } from '@/lib/api/action-guard';
import { requireUser } from '@/lib/auth/current-user';
import { LOCALE_LABELS } from '@/lib/i18n/routing';
import { localePath } from '@/lib/i18n/paths';
import { listChannels } from '@/modules/channels/list-channels';
import { addAsset, selectAsset } from '@/modules/content/assets';
import { setTimeZone } from '@/modules/content/calendar';
import { AddAssetRequest, UpdateProjectRequest } from '@/modules/content/inputs';
import {
  deleteProject,
  getProject,
  statusBeforeArchive,
  updateProject,
} from '@/modules/content/projects';
import { userTimeZone } from '@/modules/content/shared';

export const dynamic = 'force-dynamic';

/** Always shown, even before the first version, so the next step is obvious. */
const PRIMARY_KINDS: AssetKind[] = ['TITLE', 'DESCRIPTION', 'SCRIPT'];
const STUDIO_TOOL: Partial<Record<AssetKind, string>> = {
  TITLE: 'titles',
  DESCRIPTION: 'description',
  SCRIPT: 'script',
};

export default async function ProjectPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; projectId: string }>;
  searchParams: Promise<{ error?: string; saved?: string }>;
}) {
  const { locale, projectId } = await params;
  const query = await searchParams;
  setRequestLocale(locale);

  const user = await requireUser(locale);
  const [result, zone, channels] = await Promise.all([
    getProject(user.id, projectId),
    userTimeZone(user.id),
    listChannels({ userId: user.id }),
  ]);
  if (!result.ok) notFound();
  const project = result.data;
  const channelList = channels.ok ? channels.data.channels : [];

  const t = await getTranslations('project');
  const tc = await getTranslations('content');
  const dateTime = new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: zone,
  });
  const self = localePath(locale, `/projects/${projectId}`);
  const status = project.status as ProjectStatus;

  async function saveDetails(formData: FormData) {
    'use server';
    const current = await requireUser(locale);
    if (!(await guardAction(`user:${current.id}`))) redirect(`${self}?error=errors.tooManyActions`);
    const parsed = UpdateProjectRequest.safeParse({
      title: formData.get('title'),
      notes: formData.get('notes') ?? '',
      scheduledFor: formData.get('scheduledFor') ?? '',
      channelId: formData.get('channelId') ? formData.get('channelId') : null,
      locale: formData.get('locale'),
    });
    if (!parsed.success) redirect(`${self}?error=errors.validationFailed`);
    const saved = await updateProject(current.id, projectId, parsed.data);
    redirect(saved.ok ? `${self}?saved=1` : `${self}?error=${saved.error.messageKey}`);
  }

  async function changeStatus(formData: FormData) {
    'use server';
    const current = await requireUser(locale);
    if (!(await guardAction(`user:${current.id}`))) redirect(`${self}?error=errors.tooManyActions`);
    const parsed = UpdateProjectRequest.safeParse({
      status: formData.get('status'),
      statusNote: formData.get('statusNote') || undefined,
    });
    if (!parsed.success) redirect(`${self}?error=errors.validationFailed`);
    const moved = await updateProject(current.id, projectId, parsed.data);
    redirect(moved.ok ? self : `${self}?error=${moved.error.messageKey}`);
  }

  async function addVersion(formData: FormData) {
    'use server';
    const current = await requireUser(locale);
    if (!(await guardAction(`user:${current.id}`))) redirect(`${self}?error=errors.tooManyActions`);
    const parsed = AddAssetRequest.safeParse({
      kind: formData.get('kind'),
      body: formData.get('body'),
    });
    if (!parsed.success) redirect(`${self}?error=errors.validationFailed#assets`);
    const added = await addAsset(current.id, projectId, parsed.data);
    redirect(added.ok ? `${self}#assets` : `${self}?error=${added.error.messageKey}#assets`);
  }

  async function select(formData: FormData) {
    'use server';
    const current = await requireUser(locale);
    if (!(await guardAction(`user:${current.id}`))) redirect(`${self}?error=errors.tooManyActions`);
    const selected = await selectAsset(
      current.id,
      projectId,
      String(formData.get('assetId') ?? ''),
    );
    redirect(selected.ok ? `${self}#assets` : `${self}?error=${selected.error.messageKey}`);
  }

  async function remove() {
    'use server';
    const current = await requireUser(locale);
    if (!(await guardAction(`user:${current.id}`))) redirect(`${self}?error=errors.tooManyActions`);
    const removed = await deleteProject(current.id, projectId);
    redirect(
      removed.ok ? localePath(locale, '/projects') : `${self}?error=${removed.error.messageKey}`,
    );
  }

  async function useZone(formData: FormData) {
    'use server';
    const current = await requireUser(locale);
    if (!(await guardAction(`user:${current.id}`))) redirect(`${self}?error=errors.tooManyActions`);
    const saved = await setTimeZone(current.id, String(formData.get('timezone') ?? ''));
    redirect(saved.ok ? self : `${self}?error=${saved.error.messageKey}`);
  }

  // Versions grouped by kind, then locale; newest first within each.
  const groups = new Map<string, typeof project.assets>();
  for (const asset of project.assets) {
    const key = `${asset.kind}|${asset.locale}`;
    groups.set(key, [...(groups.get(key) ?? []), asset]);
  }
  const multipleLocales = new Set(project.assets.map((a) => a.locale)).size > 1;
  const kindsShown = ASSET_KINDS.filter(
    (kind) => PRIMARY_KINDS.includes(kind) || project.assets.some((a) => a.kind === kind),
  );
  const restoreTo = statusBeforeArchive(project.statusEvents);
  const studioLink = (tool: string) =>
    localePath(locale, `/studio?tool=${tool}&project=${projectId}`);

  return (
    <main className="page page--wide">
      <p className="small">
        <Link href={localePath(locale, '/projects')}>← {t('back')}</Link>
      </p>
      <header className="page__header">
        <h1>{project.title}</h1>
        <p>
          <span className="badge">{tc(`statuses.${status}`)}</span>
          {project.channel && <span className="muted"> · {project.channel.title}</span>}
          {project.publishedAt && (
            <span className="muted">
              {' '}
              · {t('status.published', { date: dateTime.format(project.publishedAt) })}
            </span>
          )}
        </p>
      </header>

      <ErrorFlash error={query.error} />
      {query.saved && (
        <p className="flash flash--ok" role="status">
          {tc('saved')}
        </p>
      )}

      <div className="split">
        <section className="card">
          <h2>{t('details')}</h2>
          {/* Its own form, so it must sit outside the details form: forms cannot nest. */}
          <TimeZonePrompt
            current={zone}
            action={useZone}
            shownInLabel={tc('timeZone.shownIn', { zone })}
            useLabel={tc('timeZone.use', { zone: '{zone}' })}
          />
          <form action={saveDetails} className="form">
            <Field label={t('fields.title')}>
              <input name="title" required maxLength={150} defaultValue={project.title} />
            </Field>
            <Field label={t('fields.scheduledFor')} hint={t('fields.scheduledHint')}>
              <input
                name="scheduledFor"
                type="datetime-local"
                defaultValue={
                  project.scheduledFor ? toLocalDateTimeInput(project.scheduledFor, zone) : ''
                }
              />
            </Field>
            <div className="form__row">
              <Field label={t('fields.channel')}>
                <select name="channelId" defaultValue={project.channelId ?? ''}>
                  <option value="">{t('fields.noChannel')}</option>
                  {channelList.map((channel) => (
                    <option key={channel.id} value={channel.id}>
                      {channel.title}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t('fields.language')}>
                <select name="locale" defaultValue={project.locale}>
                  {SUPPORTED_LOCALES.map((code) => (
                    <option key={code} value={code}>
                      {LOCALE_LABELS[code]}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <Field label={t('fields.notes')}>
              <textarea name="notes" rows={5} maxLength={5000} defaultValue={project.notes ?? ''} />
            </Field>
            <div className="form__actions">
              <SubmitButton label={t('save')} pendingLabel={t('saving')} />
            </div>
          </form>
        </section>

        <section className="card">
          <h2>{t('status.heading')}</h2>
          <form action={changeStatus} className="form">
            <Field label={t('status.moveTo')}>
              <select name="status" defaultValue={status === 'ARCHIVED' ? restoreTo : status}>
                {PROJECT_STATUSES.filter((s) => s !== 'ARCHIVED').map((s) => (
                  <option key={s} value={s}>
                    {tc(`statuses.${s}`)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('status.note')}>
              <input name="statusNote" maxLength={300} />
            </Field>
            <div className="form__actions">
              <SubmitButton label={t('status.move')} pendingLabel={t('status.moving')} />
            </div>
          </form>
          <form action={changeStatus}>
            <input
              type="hidden"
              name="status"
              value={status === 'ARCHIVED' ? restoreTo : 'ARCHIVED'}
            />
            <button type="submit" className="button button--quiet">
              {status === 'ARCHIVED'
                ? t('status.restore', { status: tc(`statuses.${restoreTo}`) })
                : t('status.archive')}
            </button>
          </form>

          <h3>{t('history.heading')}</h3>
          <ol className="timeline">
            {project.statusEvents.map((event) => (
              <li key={event.id}>
                <span>
                  {event.fromStatus
                    ? t('history.moved', {
                        from: tc(`statuses.${event.fromStatus as ProjectStatus}`),
                        to: tc(`statuses.${event.toStatus as ProjectStatus}`),
                      })
                    : t('history.created', {
                        status: tc(`statuses.${event.toStatus as ProjectStatus}`),
                      })}
                </span>
                <span className="muted small"> · {dateTime.format(event.createdAt)}</span>
                {event.note && <p className="small">{event.note}</p>}
              </li>
            ))}
          </ol>
        </section>
      </div>

      <section className="card" id="assets">
        <h2>{t('assets.heading')}</h2>
        <p className="muted">{t('assets.intro')}</p>

        {kindsShown.map((kind) => {
          const localesForKind = [...groups.entries()].filter(([key]) =>
            key.startsWith(`${kind}|`),
          );
          const tool = STUDIO_TOOL[kind];
          return (
            <div key={kind} className="asset-group">
              <div className="asset-group__head">
                <h3>{tc(`kinds.${kind}`)}</h3>
                {tool && (
                  <Link className="button button--quiet small" href={studioLink(tool)}>
                    {t('assets.generate')}
                  </Link>
                )}
              </div>
              {localesForKind.length === 0 && <p className="muted small">{t('assets.none')}</p>}
              {localesForKind.map(([key, versions]) => {
                const selected = versions.find((v) => v.isSelected);
                return (
                  <div key={key}>
                    {multipleLocales && (
                      <p className="small muted">
                        {LOCALE_LABELS[versions[0]?.locale as keyof typeof LOCALE_LABELS] ??
                          versions[0]?.locale}
                      </p>
                    )}
                    <ol className="versions">
                      {versions.map((version) => (
                        <li
                          key={version.id}
                          className={version.isSelected ? 'version is-selected' : 'version'}
                        >
                          <details open={version.isSelected}>
                            <summary>
                              <strong>{t('assets.version', { version: version.version })}</strong>
                              {version.isSelected && (
                                <span className="badge badge--ok">{t('assets.selected')}</span>
                              )}
                              <span className="muted small">
                                {' '}
                                {t('assets.by', {
                                  source: tc(`sources.${version.createdBy}`),
                                })}{' '}
                                · {dateTime.format(version.createdAt)} ·{' '}
                                {t('assets.characters', {
                                  count: charCount(version.body),
                                  max: ASSET_MAX_CHARS[kind],
                                })}
                              </span>
                            </summary>
                            <pre className="result__text">{version.body}</pre>
                            <div className="actions-row">
                              {!version.isSelected && (
                                <form action={select}>
                                  <input type="hidden" name="assetId" value={version.id} />
                                  <button type="submit" className="button">
                                    {t('assets.select')}
                                  </button>
                                </form>
                              )}
                              {selected && !version.isSelected && (
                                <Link
                                  className="button button--quiet"
                                  href={localePath(
                                    locale,
                                    `/projects/${projectId}/compare?a=${selected.id}&b=${version.id}`,
                                  )}
                                >
                                  {t('assets.compare')}
                                </Link>
                              )}
                            </div>
                          </details>
                        </li>
                      ))}
                    </ol>
                  </div>
                );
              })}
            </div>
          );
        })}

        <h3>{t('assets.add')}</h3>
        <form action={addVersion} className="form">
          <Field label={t('assets.kind')}>
            <select name="kind" defaultValue="TITLE">
              {ASSET_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {tc(`kinds.${kind}`)}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('assets.body')}>
            <textarea name="body" rows={6} required maxLength={60000} />
          </Field>
          <div className="form__actions">
            <SubmitButton label={t('assets.addSubmit')} pendingLabel={t('assets.adding')} />
          </div>
        </form>
      </section>

      <section className="card">
        <h2>{t('calendar.heading')}</h2>
        {project.calendar.length === 0 ? (
          <p className="muted small">{t('calendar.none')}</p>
        ) : (
          <ul className="history">
            {project.calendar.map((entry) => (
              <li key={entry.id}>
                {entry.title}{' '}
                <span className="muted small">· {dateTime.format(entry.startsAt)}</span>
              </li>
            ))}
          </ul>
        )}
        <p>
          <Link href={localePath(locale, `/calendar?project=${projectId}`)}>
            {t('calendar.add')}
          </Link>
        </p>
      </section>

      <section className="card card--danger">
        <h2>{t('danger.heading')}</h2>
        <p className="muted">{t('danger.body')}</p>
        <form action={remove}>
          <button type="submit" className="button button--danger">
            {t('danger.submit')}
          </button>
        </form>
      </section>
    </main>
  );
}
