import Link from 'next/link';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';

import type { AssetKind } from '@/domain/content/assets';
import { requireUser } from '@/lib/auth/current-user';
import { localePath } from '@/lib/i18n/paths';
import { compareAssets } from '@/modules/content/assets';

export const dynamic = 'force-dynamic';

export default async function ComparePage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; projectId: string }>;
  searchParams: Promise<{ a?: string; b?: string }>;
}) {
  const { locale, projectId } = await params;
  const { a, b } = await searchParams;
  setRequestLocale(locale);

  const user = await requireUser(locale);
  if (!a || !b || a.length > 64 || b.length > 64) notFound();
  const result = await compareAssets(user.id, projectId, a, b);
  if (!result.ok) notFound();
  const { before, after, lines } = result.data;

  const t = await getTranslations('compare');
  const tp = await getTranslations('project');
  const tc = await getTranslations('content');
  const identical = lines.every((line) => line.op === 'same');

  return (
    <main className="page page--wide">
      <p className="small">
        <Link href={localePath(locale, `/projects/${projectId}#assets`)}>← {t('back')}</Link>
      </p>
      <header className="page__header">
        <h1>
          {t('title')} · {tc(`kinds.${before.kind as AssetKind}`)}
        </h1>
        <p className="muted">
          {tp('assets.version', { version: before.version })} →{' '}
          {tp('assets.version', { version: after.version })}
        </p>
      </header>

      <section className="card">
        {identical ? (
          <p>{t('identical')}</p>
        ) : (
          <>
            <p className="muted small">
              {t('legend', { before: before.version, after: after.version })}
            </p>
            <pre className="diff">
              {lines.map((line, index) => (
                <span key={index} className={`diff__line diff__line--${line.op}`}>
                  <span className="diff__mark">
                    {line.op === 'added' ? '+' : line.op === 'removed' ? '−' : ' '}
                  </span>
                  {line.text || ' '}
                  {'\n'}
                </span>
              ))}
            </pre>
          </>
        )}
      </section>
    </main>
  );
}
