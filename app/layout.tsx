import type { ReactNode } from 'react';

/**
 * Root layout. The locale segment owns <html lang>, so this one only exists to
 * satisfy Next's requirement for a root layout.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return children;
}
