import type { ReactNode } from 'react';

/**
 * Dashboard layout — a Server Component with no client JS of its own.
 *
 * It exists to scope the `loading.tsx` and `error.tsx` boundaries to this route
 * segment. Without a layout here those boundaries would sit at the root and a
 * chart error would take down the landing page too.
 */
export default function DashboardLayout({ children }: { children: ReactNode }) {
  return children;
}
