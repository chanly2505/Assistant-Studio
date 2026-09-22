import type { ReactNode } from 'react';

/** A labelled form control with an optional hint below it. */
export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string | undefined;
  children: ReactNode;
}) {
  return (
    <label className="form__field">
      <span className="form__label">{label}</span>
      {children}
      {hint && <span className="form__hint">{hint}</span>}
    </label>
  );
}
