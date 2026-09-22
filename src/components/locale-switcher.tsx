'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';

/**
 * Plain links to the current page in each language, so switching works
 * without JavaScript and keeps the user where they are. next-intl remembers
 * the choice in its locale cookie for later visits to "/".
 */
export function LocaleSwitcher({
  current,
  options,
  label,
}: {
  current: string;
  options: Array<{ code: string; label: string; draft: boolean }>;
  label: string;
}) {
  const pathname = usePathname() ?? '/';
  const search = useSearchParams()?.toString() ?? '';

  const hrefFor = (code: string) => {
    const segments = pathname.split('/');
    // pathname is "/<locale>/rest…"; replace the locale segment.
    segments[1] = code;
    return `${segments.join('/') || `/${code}`}${search ? `?${search}` : ''}`;
  };

  return (
    <nav className="locale-switcher" aria-label={label}>
      <span className="locale-switcher__label">{label}:</span>
      <ul>
        {options.map((option) => (
          <li key={option.code}>
            {option.code === current ? (
              <span aria-current="true" className="locale-switcher__current" lang={option.code}>
                {option.label}
              </span>
            ) : (
              <Link href={hrefFor(option.code)} lang={option.code} hrefLang={option.code}>
                {option.label}
              </Link>
            )}
            {option.draft && <span className="locale-switcher__draft"> *</span>}
          </li>
        ))}
      </ul>
    </nav>
  );
}
