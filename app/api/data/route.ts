import { NextResponse, type NextRequest } from 'next/server';
import { generateDataset } from '@/lib/dataGenerator';
import { CATEGORIES, type Category } from '@/lib/types';

/**
 * Seed dataset endpoint.
 *
 * Runs on the edge: this is pure arithmetic with no filesystem, database or
 * Node built-in in sight, so there is nothing to gain from a Node lambda and a
 * lot to gain from starting in single-digit milliseconds close to the user.
 *
 * The dashboard page itself does *not* go through here — a Server Component
 * calling `fetch` on its own route handler is a pointless network hop. This
 * exists for the "refill from server" control and so the data contract is
 * inspectable, which is what a route handler is actually good for.
 */

export const runtime = 'edge';
// Every response depends on `?count`/`?seed`, so caching the route itself would
// be wrong. The per-response Cache-Control below is the right granularity.
export const dynamic = 'force-dynamic';

const MAX_POINTS = 200_000;

export async function GET(request: NextRequest) {
  const started = performance.now();
  const params = request.nextUrl.searchParams;

  const count = clampInt(params.get('count'), 10_000, 1, MAX_POINTS);
  const seed = clampInt(params.get('seed'), 20240607, 1, 2 ** 31 - 1);
  const intervalMs = clampInt(params.get('interval'), 100, 1, 60_000);

  const requested = params.get('categories');
  const categories: Category[] = requested
    ? requested
        .split(',')
        .map((c) => c.trim())
        .filter((c): c is Category => (CATEGORIES as readonly string[]).includes(c))
    : [...CATEGORIES];

  if (categories.length === 0) {
    return NextResponse.json(
      { error: 'No valid categories requested', valid: CATEGORIES },
      { status: 400 },
    );
  }

  const points = generateDataset({ count, seed, intervalMs, categories });

  // Note this returns the explicit `DataPoint[]` form rather than the compact
  // columnar snapshot the dashboard page uses internally. This is a public
  // contract — anyone curling it should get something self-describing, and the
  // response is gzipped on the wire anyway.
  const payload = {
    points,
    generatedAt: Date.now(),
    seed,
    generationMs: Math.round((performance.now() - started) * 100) / 100,
  };

  return NextResponse.json(payload, {
    headers: {
      // Deterministic for a given (count, seed) pair, so it is genuinely
      // cacheable — but the client is usually asking because it wants a fresh
      // window, hence the short max-age with a long stale window.
      'Cache-Control': 'public, s-maxage=10, stale-while-revalidate=59',
      'X-Generation-Ms': String(payload.generationMs),
      'X-Point-Count': String(points.length),
    },
  });
}

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw === null) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
