'use client';

import { useFormStatus } from 'react-dom';

/**
 * A submit button that shows progress while its form's server action runs.
 * AI generation can take tens of seconds; without this the page looks frozen
 * and people click again (which the rate limit would then refuse).
 */
export function SubmitButton({
  label,
  pendingLabel,
  className = 'button button--primary',
}: {
  label: string;
  pendingLabel: string;
  className?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className={className} disabled={pending} aria-busy={pending}>
      {pending ? pendingLabel : label}
    </button>
  );
}
