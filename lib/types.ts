/**
 * Shared vocabulary for the dashboard.
 *
 * A note on `DataPoint`: it exists because it is the natural shape to talk about
 * a single reading, and it is what the API route hands back. It is *not* how the
 * data lives in memory once it reaches the client — 100k of these objects is
 * roughly 12 MB of heap and a garbage collector pause every few seconds. See
 * `lib/seriesBuffer.ts` for the columnar form we actually stream into.
 */

export interface DataPoint {
  timestamp: number;
  value: number;
  category: string;
  metadata?: Record<string, unknown>;
}

export type ChartType = 'line' | 'bar' | 'scatter' | 'heatmap';

export interface ChartConfig {
  id: ChartType;
  title: string;
  subtitle: string;
  type: ChartType;
  dataKey: string;
  color: string;
  visible: boolean;
}

export interface PerformanceMetrics {
  fps: number;
  /** Slowest frame in the sampling window — the number that actually gets noticed. */
  worstFrameMs: number;
  /** 95th percentile frame time. A 60fps average hides a lot of jank. */
  p95FrameMs: number;
  memoryUsage: number;
  memoryLimit: number;
  renderTime: number;
  dataProcessingTime: number;
  droppedFrames: number;
}

/** The eight simulated telemetry channels. Order is the wire format — don't reorder. */
export const CATEGORIES = [
  'cpu',
  'memory',
  'network',
  'disk',
  'latency',
  'throughput',
  'errors',
  'queue',
] as const;

export type Category = (typeof CATEGORIES)[number];

export interface CategoryMeta {
  id: Category;
  label: string;
  unit: string;
  color: string;
  /** Baseline the random walk is pulled back toward. */
  center: number;
  /** How far a single tick can move. */
  volatility: number;
  min: number;
  max: number;
}

export type AggregationWindow = '1s' | '1m' | '5m' | '1h' | 'none';

export const AGGREGATION_WINDOWS: { id: AggregationWindow; label: string; ms: number }[] = [
  { id: 'none', label: 'Raw', ms: 0 },
  { id: '1s', label: '1 sec', ms: 1_000 },
  { id: '1m', label: '1 min', ms: 60_000 },
  { id: '5m', label: '5 min', ms: 300_000 },
  { id: '1h', label: '1 hour', ms: 3_600_000 },
];

export type TimeRangePreset = '1m' | '5m' | '15m' | '1h' | '6h' | 'all';

export const TIME_RANGES: { id: TimeRangePreset; label: string; ms: number }[] = [
  { id: '1m', label: '1m', ms: 60_000 },
  { id: '5m', label: '5m', ms: 300_000 },
  { id: '15m', label: '15m', ms: 900_000 },
  { id: '1h', label: '1h', ms: 3_600_000 },
  { id: '6h', label: '6h', ms: 21_600_000 },
  { id: 'all', label: 'All', ms: Number.POSITIVE_INFINITY },
];

/** Everything the charts read to decide *what* to draw. */
export interface DashboardFilters {
  categories: Set<Category>;
  timeRange: TimeRangePreset;
  aggregation: AggregationWindow;
  valueMin: number;
  valueMax: number;
  search: string;
}

/** Knobs exposed by the load / stress-test panel. */
export interface StreamSettings {
  /** Ring buffer capacity — the "how many points are we holding" number. */
  capacity: number;
  /** Milliseconds between generator ticks. The spec calls for 100. */
  intervalMs: number;
  /** Points emitted per tick. Stress mode cranks this. */
  batchSize: number;
  running: boolean;
  stressMode: boolean;
}

/** A viewport into the data, in data-space. Charts own one of these for zoom/pan. */
export interface Viewport {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
}

/** Result of collapsing raw points into per-pixel-column buckets. */
export interface AggregatedBucket {
  t: number;
  min: number;
  max: number;
  avg: number;
  count: number;
}

export interface DatasetSnapshot {
  points: DataPoint[];
  generatedAt: number;
  seed: number;
  /** Wall-clock the server spent generating — surfaced in the UI as a nice touch. */
  generationMs: number;
}
