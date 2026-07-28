import type { Metadata } from 'next';
import { DataProvider } from '@/components/providers/DataProvider';
import { Dashboard } from '@/components/Dashboard';
import { generateDataset } from '@/lib/dataGenerator';
import { DEFAULT_SEED, INITIAL_POINT_COUNT } from '@/lib/chartConfig';
import type { DatasetSnapshot } from '@/lib/types';

/**
 * The dashboard page — a Server Component.
 *
 * It generates the first 10,000 points on the server and hands them to the
 * client as props. That is worth doing for a real reason, not just to tick the
 * "used a Server Component" box: the alternative is a client that mounts empty,
 * fetches, and then paints, which means an empty chart frame the user actually
 * sees. Here the first paint already has a full dataset behind it.
 *
 * Note what is *not* here: no `fetch` to our own `/api/data` route. A Server
 * Component calling its own route handler is a network round trip to reach a
 * function that is already in the same process. The route handler exists for
 * clients; the page calls the generator directly.
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
  const started = performance.now();

  const points = generateDataset({
    count: INITIAL_POINT_COUNT,
    seed: DEFAULT_SEED,
    intervalMs: 100,
  });

  const initialData: DatasetSnapshot = {
    points,
    generatedAt: Date.now(),
    seed: DEFAULT_SEED,
    generationMs: Math.round((performance.now() - started) * 100) / 100,
  };

  return (
    <DataProvider initialData={initialData}>
      <Dashboard />
    </DataProvider>
  );
}
