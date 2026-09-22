'use client';

import { useEffect, useState } from 'react';

/**
 * Dates are entered and shown in the user's saved time zone. The server cannot
 * know the browser's, so this reads it here and, when it differs, offers a
 * one-click switch. Nothing changes without that click.
 */
export function TimeZonePrompt({
  current,
  action,
  shownInLabel,
  useLabel,
}: {
  current: string;
  action: (formData: FormData) => Promise<void>;
  /** Already formatted with the current zone. */
  shownInLabel: string;
  /** Contains `{zone}`, replaced with the detected zone. */
  useLabel: string;
}) {
  const [detected, setDetected] = useState<string | null>(null);

  useEffect(() => {
    try {
      setDetected(Intl.DateTimeFormat().resolvedOptions().timeZone ?? null);
    } catch {
      setDetected(null);
    }
  }, []);

  return (
    <form action={action} className="tz-prompt small muted">
      <span>{shownInLabel}</span>
      {detected && detected !== current && (
        <>
          <input type="hidden" name="timezone" value={detected} />
          <button type="submit" className="button button--quiet">
            {useLabel.replace('{zone}', detected)}
          </button>
        </>
      )}
    </form>
  );
}
