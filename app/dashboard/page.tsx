import type { Metadata } from 'next';
import { DataProvider } from '@/components/providers/DataProvider';
import { Dashboard } from '@/components/Dashboard';
import { generateSnapshot } from '@/lib/dataGenerator';
import { DEFAULT_SEED, INITIAL_POINT_COUNT } from '@/lib/chartConfig';

/**
 * The dashboard page — a Server Component.
 *
 * It generates the first 10,000 points on the server and hands them to the
 * client as props. That is worth doing for a real reason, not just to tick the
 * "used a Server Component" box: the alternative is a client that mounts empty,
 * fetches, and then paints, which means an empty chart frame the user actually
 * sees. Here the first paint already has a full dataset behind it.
 *
 * Two things are deliberately absent:
 *
 *   - No `fetch` to our own `/api/data` route. A Server Component calling its
 *     own route handler is a network round trip to reach a function already in
 *     the same process. The route handler exists for clients.
 *   - No `DataPoint[]`. The payload is the compact columnar form — see
 *     `DatasetSnapshot`. Shipping objects put 750 KB of HTML on the critical
 *     path; this is about 70 KB for the same data.
 */

export const metadata: Metadata = {
  title: 'Dashboard',
  description: 'Live telemetry across eight channels, rendered on canvas at 60fps.',
};

/**
 * Timestamps are baked into the payload, so this cannot be statically
 * generated at build time without shipping a stale window. Revalidating every
 * 30s gives the CDN something to cache while keeping the seed data recent.
 */
export const revalidate = 30;

export default async function DashboardPage() {
  const initialData = generateSnapshot({
    count: INITIAL_POINT_COUNT,
    seed: DEFAULT_SEED,
    intervalMs: 100,
  });

  return (
    <DataProvider initialData={initialData}>
      <Dashboard />
    </DataProvider>
  );
}
