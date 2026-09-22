import Link from 'next/link';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { redirect } from 'next/navigation';

import { Field } from '@/components/forms/field';
import { SubmitButton } from '@/components/forms/submit-button';
import { TimeZonePrompt } from '@/components/forms/time-zone-prompt';
import type { ProjectStatus } from '@/domain/content/status';
import { localDateKey, monthGrid, monthKey, parseMonth, shiftMonth } from '@/domain/content/time';
import { requireUser } from '@/lib/auth/current-user';
import { errorMessageKey } from '@/lib/i18n/error-key';
import { localePath } from '@/lib/i18n/paths';
import {
  createCalendarEntry,
  deleteCalendarEntry,
  getCalendarMonth,
  setTimeZone,
  updateCalendarEntry,
  type CalendarItem,
} from '@/modules/content/calendar';
import { CreateCalendarEntryRequest } from '@/modules/content/inputs';
import { listProjects } from '@/modules/content/projects';
import { userTimeZone } from '@/modules/content/shared';

export const dynamic = 'force-dynamic';

export default async function CalendarPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ month?: string; project?: string; error?: string }>;
}) {
  const { locale } = await params;
  const query = await searchParams;
  setRequestLocale(locale);

  const user = await requireUser(locale);
  const zone = await userTimeZone(user.id);
  const todayKey = localDateKey(new Date(), zone);
  const [ty, tm] = todayKey.split('-').map(Number) as [number, number];
  const { year, month } = parseMonth(query.month) ?? { year: ty, month: tm };
  const current = monthKey(year, month);

  const [calendar, projects] = await Promise.all([
    getCalendarMonth(user.id, year, month),
    listProjects(user.id),
  ]);
  const items = calendar.ok ? calendar.data.items : [];
  const projectList = projects.ok ? projects.data.projects : [];

  const t = await getTranslations('calendar');
  const tc = await getTranslations('content');
  const tRoot = await getTranslations();
  const errorKey = errorMessageKey(query.error);
  const self = localePath(locale, `/calendar?month=${current}`);

  const monthTitle = new Intl.DateTimeFormat(locale, {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, month - 1, 1)));
  // Weekday names from a known Monday, so they follow the page language.
  const weekdayFormat = new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' });
  const weekdays = Array.from({ length: 7 }, (_, i) =>
    weekdayFormat.format(new Date(Date.UTC(2024, 0, 1 + i))),
  );
  const time = new Intl.DateTimeFormat(locale, { timeStyle: 'short', timeZone: zone });
  const dayLabel = new Intl.DateTimeFormat(locale, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  });
  const prev = shiftMonth(year, month, -1);
  const next = shiftMonth(year, month, 1);

  const byDay = new Map<string, CalendarItem[]>();
  for (const item of items) byDay.set(item.dayKey, [...(byDay.get(item.dayKey) ?? []), item]);

  async function add(formData: FormData) {
    'use server';
    const me = await requireUser(locale);
    const date = String(formData.get('date') ?? '');
    const at = String(formData.get('time') ?? '');
    const parsed = CreateCalendarEntryRequest.safeParse({
      title: formData.get('title'),
      entryType: formData.get('entryType') || undefined,
      startsAt: at ? `${date}T${at}` : date,
      notes: formData.get('notes') || undefined,
      projectId: formData.get('projectId') || undefined,
    });
    const back = localePath(locale, `/calendar?month=${date.slice(0, 7) || current}`);
    if (!parsed.success) redirect(`${back}&error=errors.validationFailed`);
    const created = await createCalendarEntry(me.id, parsed.data);
    redirect(created.ok ? back : `${back}&error=${created.error.messageKey}`);
  }

  async function act(formData: FormData) {
    'use server';
    const me = await requireUser(locale);
    const entryId = String(formData.get('entryId') ?? '');
    const action = String(formData.get('action') ?? '');
    const outcome =
      action === 'delete'
        ? await deleteCalendarEntry(me.id, entryId)
        : await updateCalendarEntry(me.id, entryId, {
            status: action === 'done' ? 'DONE' : 'PENDING',
          });
    redirect(outcome.ok ? self : `${self}&error=${outcome.error.messageKey}`);
  }

  async function useZone(formData: FormData) {
    'use server';
    const me = await requireUser(locale);
    const saved = await setTimeZone(me.id, String(formData.get('timezone') ?? ''));
    redirect(saved.ok ? self : `${self}&error=${saved.error.messageKey}`);
  }

  const label = (item: CalendarItem) =>
    item.type === 'project' ? (
      <Link href={localePath(locale, `/projects/${item.id}`)}>{item.title}</Link>
    ) : (
      <span className={item.status === 'DONE' ? 'is-done' : undefined}>{item.title}</span>
    );

  return (
    <main className="page page--full">
      <header className="page__header">
        <h1>{t('title')}</h1>
        <p className="muted">{t('subtitle')}</p>
        <TimeZonePrompt
          current={zone}
          action={useZone}
          shownInLabel={tc('timeZone.shownIn', { zone })}
          useLabel={tc('timeZone.use', { zone: '{zone}' })}
        />
      </header>

      {errorKey && tRoot.has(errorKey) && (
        <p className="flash flash--bad" role="alert">
          {tRoot(errorKey as 'errors.notFound')}
        </p>
      )}

      <nav className="month-nav" aria-label={monthTitle}>
        <Link href={localePath(locale, `/calendar?month=${monthKey(prev.year, prev.month)}`)}>
          ← {t('previous')}
        </Link>
        <h2>{monthTitle}</h2>
        <Link href={localePath(locale, `/calendar?month=${monthKey(next.year, next.month)}`)}>
          {t('next')} →
        </Link>
      </nav>
      {current !== todayKey.slice(0, 7) && (
        <p className="small">
          <Link href={localePath(locale, '/calendar')}>{t('thisMonth')}</Link>
        </p>
      )}

      {/* The grid is for wide screens (hidden on phones); the list below carries the same items on every screen. */}
      <table className="month-grid">
        <caption className="visually-hidden">{monthTitle}</caption>
        <thead>
          <tr>
            {weekdays.map((day) => (
              <th key={day} scope="col">
                {day}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {monthGrid(year, month).map((week, index) => (
            <tr key={index}>
              {week.map((day, dayIndex) => (
                <td
                  key={day ?? `blank-${dayIndex}`}
                  className={day === todayKey ? 'month-grid__day is-today' : 'month-grid__day'}
                >
                  {day && (
                    <>
                      <span className="month-grid__date">{Number(day.slice(8))}</span>
                      <ul>
                        {(byDay.get(day) ?? []).map((item) => (
                          <li key={`${item.type}-${item.id}`} className={`chip chip--${item.type}`}>
                            {label(item)}
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>

      <section className="card">
        <h2>{t('listHeading')}</h2>
        {items.length === 0 ? (
          <p className="muted">{t('empty')}</p>
        ) : (
          <ol className="agenda">
            {[...byDay.entries()].map(([day, dayItems]) => (
              <li key={day}>
                <h3 className="agenda__day">{dayLabel.format(new Date(`${day}T00:00:00Z`))}</h3>
                <ul>
                  {dayItems.map((item) => (
                    <li key={`${item.type}-${item.id}`} className="agenda__item">
                      <span className="agenda__time muted small">
                        {item.type === 'entry' && item.allDay ? t('allDay') : time.format(item.at)}
                      </span>
                      <span>
                        <span className="badge">
                          {item.type === 'project'
                            ? tc(`statuses.${item.status as ProjectStatus}`)
                            : t(`entryTypes.${item.entryType as 'TASK'}`)}
                        </span>{' '}
                        {label(item)}
                        {item.type === 'entry' && item.status === 'DONE' && (
                          <span className="muted small"> · {t('statusDone')}</span>
                        )}
                      </span>
                      {item.type === 'entry' && (
                        <span className="actions-row">
                          <form action={act}>
                            <input type="hidden" name="entryId" value={item.id} />
                            <input
                              type="hidden"
                              name="action"
                              value={item.status === 'DONE' ? 'undo' : 'done'}
                            />
                            <button type="submit" className="button button--quiet small">
                              {item.status === 'DONE' ? t('undo') : t('done')}
                            </button>
                          </form>
                          <form action={act}>
                            <input type="hidden" name="entryId" value={item.id} />
                            <input type="hidden" name="action" value="delete" />
                            <button type="submit" className="button button--quiet small">
                              {t('delete')}
                            </button>
                          </form>
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="card">
        <h2>{t('add.heading')}</h2>
        <form action={add} className="form">
          <Field label={t('add.title')}>
            <input name="title" required maxLength={150} />
          </Field>
          <div className="form__row">
            <Field label={t('add.date')}>
              <input
                name="date"
                type="date"
                required
                defaultValue={current === todayKey.slice(0, 7) ? todayKey : `${current}-01`}
              />
            </Field>
            <Field label={t('add.time')} hint={t('add.timeHint')}>
              <input name="time" type="time" />
            </Field>
            <Field label={t('add.type')}>
              <select name="entryType" defaultValue="TASK">
                {(['TASK', 'REMINDER', 'NOTE'] as const).map((type) => (
                  <option key={type} value={type}>
                    {t(`entryTypes.${type}`)}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Field label={t('add.project')}>
            <select name="projectId" defaultValue={query.project ?? ''}>
              <option value="">{t('add.noProject')}</option>
              {projectList.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.title}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('add.notes')}>
            <textarea name="notes" rows={3} maxLength={2000} />
          </Field>
          <div className="form__actions">
            <SubmitButton label={t('add.submit')} pendingLabel={t('add.submitting')} />
          </div>
        </form>
      </section>
    </main>
  );
}
