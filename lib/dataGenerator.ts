import {
  CATEGORIES,
  type Category,
  type CategoryMeta,
  type DataPoint,
  type DatasetSnapshot,
} from './types';

/**
 * Seeded time-series generation.
 *
 * Everything here is deterministic on purpose. Two reasons:
 *   1. The server component renders the first 10k points and the client picks up
 *      the stream from there. If the two disagreed we'd get a hydration mismatch.
 *   2. Benchmarks are worthless if the data changes between runs.
 */

/** mulberry32 — small, fast, good enough distribution for synthetic telemetry. */
export function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box–Muller. Random walks driven by uniform noise look wrong; Gaussian looks like real telemetry. */
function gaussian(rng: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export const CATEGORY_META: Record<Category, CategoryMeta> = {
  cpu: {
    id: 'cpu',
    label: 'CPU Load',
    unit: '%',
    color: '#6ea8fe',
    center: 46,
    volatility: 2.6,
    min: 0,
    max: 100,
  },
  memory: {
    id: 'memory',
    label: 'Memory',
    unit: '%',
    color: '#8b7cf6',
    center: 62,
    volatility: 1.1,
    min: 0,
    max: 100,
  },
  network: {
    id: 'network',
    label: 'Network I/O',
    unit: 'Mb/s',
    color: '#2dd4bf',
    center: 340,
    volatility: 26,
    min: 0,
    max: 1000,
  },
  disk: {
    id: 'disk',
    label: 'Disk I/O',
    unit: 'MB/s',
    color: '#f5a524',
    center: 120,
    volatility: 14,
    min: 0,
    max: 600,
  },
  latency: {
    id: 'latency',
    label: 'p99 Latency',
    unit: 'ms',
    color: '#f472b6',
    center: 88,
    volatility: 7,
    min: 1,
    max: 900,
  },
  throughput: {
    id: 'throughput',
    label: 'Throughput',
    unit: 'req/s',
    color: '#4ade80',
    center: 1450,
    volatility: 70,
    min: 0,
    max: 4000,
  },
  errors: {
    id: 'errors',
    label: 'Error Rate',
    unit: '/min',
    color: '#f87171',
    center: 4,
    volatility: 1.4,
    min: 0,
    max: 120,
  },
  queue: {
    id: 'queue',
    label: 'Queue Depth',
    unit: 'jobs',
    color: '#a3e635',
    center: 210,
    volatility: 18,
    min: 0,
    max: 1500,
  },
};

export const CATEGORY_LIST: CategoryMeta[] = CATEGORIES.map((c) => CATEGORY_META[c]);

/** Index lookup, so the hot path can store a Uint8 instead of a string. */
export const CATEGORY_INDEX: Record<Category, number> = CATEGORIES.reduce(
  (acc, id, i) => {
    acc[id] = i;
    return acc;
  },
  {} as Record<Category, number>,
);

/**
 * Per-channel walker. Holds its own position so the stream stays continuous
 * across ticks instead of teleporting every batch.
 */
export class SeriesWalker {
  private readonly meta: CategoryMeta;
  private readonly rng: () => number;
  private value: number;
  private phase: number;
  /** Countdown until the current incident (latency spike, error burst) clears. */
  private incidentTicks = 0;
  private incidentMagnitude = 0;

  constructor(category: Category, seed: number) {
    this.meta = CATEGORY_META[category];
    this.rng = createRng(seed);
    this.value = this.meta.center;
    this.phase = this.rng() * Math.PI * 2;
  }

  /**
   * Mean-reverting random walk + a slow sine (the "daily traffic curve") + rare
   * incidents. That combination is what makes a synthetic chart stop looking
   * synthetic — pure noise reads as static, pure sine reads as a screensaver.
   */
  next(tick: number): number {
    const { center, volatility, min, max } = this.meta;

    const seasonal = Math.sin(this.phase + tick / 900) * volatility * 3.2;
    const reversion = (center - this.value) * 0.045;
    const noise = gaussian(this.rng) * volatility;

    if (this.incidentTicks > 0) {
      this.incidentTicks -= 1;
      // Exponential decay back to normal rather than a cliff edge.
      this.incidentMagnitude *= 0.93;
    } else if (this.rng() < 0.0012) {
      this.incidentTicks = 40 + Math.floor(this.rng() * 90);
      this.incidentMagnitude = volatility * (7 + this.rng() * 14);
    }

    this.value += reversion + noise + seasonal * 0.02 + this.incidentMagnitude * 0.06;
    this.value = Math.min(max, Math.max(min, this.value));

    return this.value;
  }
}

export interface GenerateOptions {
  count: number;
  seed?: number;
  /** Timestamp of the newest point. Defaults to "now". */
  endTime?: number;
  /** Spacing between consecutive points, in ms. */
  intervalMs?: number;
  categories?: readonly Category[];
}

/**
 * Builds `count` points ending at `endTime`, round-robined across categories so
 * every channel gets an even share and the timestamps stay monotonic.
 */
export function generateDataset({
  count,
  seed = 20240607,
  endTime,
  intervalMs = 100,
  categories = CATEGORIES,
}: GenerateOptions): DataPoint[] {
  const end = endTime ?? Date.now();
  const walkers = categories.map((c, i) => new SeriesWalker(c, seed + i * 7919));
  const points: DataPoint[] = new Array(count);

  const perCategory = Math.ceil(count / categories.length);
  const start = end - perCategory * intervalMs;

  for (let i = 0; i < count; i += 1) {
    const catIdx = i % categories.length;
    const step = Math.floor(i / categories.length);
    const category = categories[catIdx];

    points[i] = {
      timestamp: start + step * intervalMs,
      value: round2(walkers[catIdx].next(step)),
      category,
    };
  }

  return points;
}

/**
 * Compact variant for the server→client seed payload.
 *
 * Emits only the values; timestamps and categories are derivable from the
 * index (see `DatasetSnapshot`). Same numbers as `generateDataset`, about a
 * tenth of the serialised bytes.
 */
export function generateSnapshot({
  count,
  seed = 20240607,
  endTime,
  intervalMs = 100,
}: GenerateOptions): DatasetSnapshot {
  const started = typeof performance !== 'undefined' ? performance.now() : 0;
  const end = endTime ?? Date.now();
  const walkers = createWalkers(seed);
  const n = CATEGORIES.length;

  const steps = Math.ceil(count / n);
  const values: number[] = new Array(count);

  for (let i = 0; i < count; i += 1) {
    const catIdx = i % n;
    const step = Math.floor(i / n);
    values[i] = round2(walkers[catIdx].next(step));
  }

  return {
    values,
    startTime: end - steps * intervalMs,
    intervalMs,
    generatedAt: end,
    seed,
    generationMs:
      typeof performance !== 'undefined' ? Math.round((performance.now() - started) * 100) / 100 : 0,
  };
}

export function createWalkers(seed: number): SeriesWalker[] {
  return CATEGORIES.map((c, i) => new SeriesWalker(c, seed + i * 7919));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
