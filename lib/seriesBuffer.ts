import { CATEGORIES, type AggregatedBucket, type Category } from './types';

/**
 * Columnar ring buffers, one per telemetry channel.
 *
 * Why not `DataPoint[]`?
 *   - 100k plain objects ≈ 12 MB and a major GC every few seconds. Two Float
 *     arrays of 100k are 1.2 MB and never move.
 *   - `array.shift()` on a sliding window is O(n). A ring buffer write is O(1)
 *     and allocates nothing, which is the whole game when you're writing 80
 *     points every 100ms for hours.
 *   - Per-channel (rather than one interleaved buffer) means drawing a single
 *     series is a straight linear scan with no category test in the inner loop.
 */
export class ChannelBuffer {
  capacity: number;
  timestamps: Float64Array;
  values: Float32Array;
  /** Index the next write lands on. */
  private head = 0;
  size = 0;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.timestamps = new Float64Array(capacity);
    this.values = new Float32Array(capacity);
  }

  push(timestamp: number, value: number): void {
    this.timestamps[this.head] = timestamp;
    this.values[this.head] = value;
    this.head = (this.head + 1) % this.capacity;
    if (this.size < this.capacity) this.size += 1;
  }

  /** Logical index (0 = oldest retained point) → physical slot. */
  physical(i: number): number {
    const start = (this.head - this.size + this.capacity) % this.capacity;
    return (start + i) % this.capacity;
  }

  timeAt(i: number): number {
    return this.timestamps[this.physical(i)];
  }

  valueAt(i: number): number {
    return this.values[this.physical(i)];
  }

  get oldest(): number {
    return this.size === 0 ? 0 : this.timeAt(0);
  }

  get newest(): number {
    return this.size === 0 ? 0 : this.timeAt(this.size - 1);
  }

  /**
   * First logical index with timestamp >= t. Timestamps are monotonic within a
   * channel, so a binary search is safe and keeps zoom/pan off the O(n) path.
   */
  lowerBound(t: number): number {
    let lo = 0;
    let hi = this.size;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.timeAt(mid) < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  upperBound(t: number): number {
    let lo = 0;
    let hi = this.size;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.timeAt(mid) <= t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** Grow or shrink, keeping the most recent `min(size, next)` points. */
  resize(next: number): void {
    if (next === this.capacity) return;
    const keep = Math.min(this.size, next);
    const ts = new Float64Array(next);
    const vs = new Float32Array(next);
    const from = this.size - keep;
    for (let i = 0; i < keep; i += 1) {
      const p = this.physical(from + i);
      ts[i] = this.timestamps[p];
      vs[i] = this.values[p];
    }
    this.timestamps = ts;
    this.values = vs;
    this.capacity = next;
    this.size = keep;
    this.head = keep % next;
  }

  clear(): void {
    this.head = 0;
    this.size = 0;
  }

  /** Bytes actually held by this channel — feeds the memory readout. */
  byteLength(): number {
    return this.timestamps.byteLength + this.values.byteLength;
  }
}

export interface Extent {
  min: number;
  max: number;
}

/**
 * Owns every channel plus the notification plumbing.
 *
 * There are deliberately *two* ways to read this store:
 *
 *   - Canvas renderers read `version` inside their own rAF loop. No React
 *     involvement at all, so a 100ms data tick costs zero re-renders.
 *   - Anything that genuinely needs React state (the table, the summary tiles)
 *     subscribes and gets throttled notifications, because re-rendering a
 *     virtual list ten times a second is pointless — nobody can read that fast.
 */
export class DataStore {
  readonly channels: Record<Category, ChannelBuffer>;
  /**
   * The same buffers, indexed positionally.
   *
   * The ingest loop receives category *indices* from the worker, and going
   * `channels[CATEGORIES[i]]` turns every write into a string hash lookup. At
   * the spec'd rate that's irrelevant; at 15,000 writes a second it isn't.
   */
  readonly channelList: ChannelBuffer[];
  /** Bumped on every write. Renderers diff this to skip redundant frames. */
  version = 0;
  totalIngested = 0;
  lastWriteAt = 0;

  private listeners = new Set<() => void>();
  private extentCache: { key: string; at: number; extent: Extent } | null = null;
  private notifyTimer: ReturnType<typeof setTimeout> | null = null;
  private notifyIntervalMs: number;
  private pendingNotify = false;
  private snapshotToken = 0;

  constructor(capacity: number, notifyIntervalMs = 250) {
    this.notifyIntervalMs = notifyIntervalMs;
    this.channels = CATEGORIES.reduce(
      (acc, c) => {
        acc[c] = new ChannelBuffer(capacity);
        return acc;
      },
      {} as Record<Category, ChannelBuffer>,
    );
    this.channelList = CATEGORIES.map((c) => this.channels[c]);
  }

  /** Positional write for the ingest hot loop. */
  pushAt(categoryIndex: number, timestamp: number, value: number): void {
    this.channelList[categoryIndex].push(timestamp, value);
  }

  get capacity(): number {
    return this.channels.cpu.capacity;
  }

  get pointCount(): number {
    let n = 0;
    for (const c of CATEGORIES) n += this.channels[c].size;
    return n;
  }

  push(category: Category, timestamp: number, value: number): void {
    this.channels[category].push(timestamp, value);
    this.totalIngested += 1;
  }

  /** Call once after a batch rather than per point — keeps notify churn down. */
  commit(at: number): void {
    this.version += 1;
    this.lastWriteAt = at;
    this.scheduleNotify();
  }

  resize(capacity: number): void {
    for (const c of CATEGORIES) this.channels[c].resize(capacity);
    this.extentCache = null;
    this.version += 1;
    this.flushNotify();
  }

  clear(): void {
    for (const c of CATEGORIES) this.channels[c].clear();
    this.totalIngested = 0;
    this.extentCache = null;
    this.version += 1;
    this.flushNotify();
  }

  /** Time span currently held, across all channels. */
  timeExtent(): Extent {
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (const c of CATEGORIES) {
      const ch = this.channels[c];
      if (ch.size === 0) continue;
      if (ch.oldest < min) min = ch.oldest;
      if (ch.newest > max) max = ch.newest;
    }
    if (min === Number.POSITIVE_INFINITY) {
      const now = Date.now();
      return { min: now - 60_000, max: now };
    }
    return { min, max };
  }

  /**
   * Value extent for a set of channels inside a time window.
   *
   * This is memoised, and it needs to be. Three charts each ask for the same
   * extent on the same window, every frame — at 100k points in range that was
   * 18 million comparisons a second doing nothing but recomputing an identical
   * answer, and it was the single largest non-drawing cost in a profile.
   *
   * The cache is keyed on the exact query and expires after 100ms. Between
   * refreshes the axis can be at most a few per cent stale, which is invisible
   * next to the 8% headroom the charts add anyway — and it recomputes the
   * moment the user zooms, because that changes the key.
   */
  valueExtent(categories: Iterable<Category>, from: number, to: number): Extent {
    const cats = Array.from(categories);
    const key = `${cats.join(',')}|${from}|${to}`;
    const now = this.clock();
    const hit = this.extentCache;
    if (hit && hit.key === key && now - hit.at < 100) return hit.extent;

    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (const c of cats) {
      const ch = this.channels[c];
      if (ch.size === 0) continue;
      const start = ch.lowerBound(from);
      const end = ch.upperBound(to);
      for (let i = start; i < end; i += 1) {
        const v = ch.valueAt(i);
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }

    let extent: Extent;
    if (min === Number.POSITIVE_INFINITY) extent = { min: 0, max: 1 };
    else if (min === max) extent = { min: min - 1, max: max + 1 };
    else extent = { min, max };

    this.extentCache = { key, at: now, extent };
    return extent;
  }

  private clock(): number {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
  }

  approximateBytes(): number {
    let n = 0;
    for (const c of CATEGORIES) n += this.channels[c].byteLength();
    return n;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /**
   * Monotonic token for `useSyncExternalStore`. It only moves when we actually
   * notify, which is what keeps subscribers off the 100ms path.
   */
  getSnapshot = (): number => this.snapshotToken;

  getServerSnapshot = (): number => 0;

  setNotifyInterval(ms: number): void {
    this.notifyIntervalMs = ms;
  }

  private scheduleNotify(): void {
    if (this.notifyTimer !== null) {
      this.pendingNotify = true;
      return;
    }
    this.flushNotify();
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null;
      if (this.pendingNotify) {
        this.pendingNotify = false;
        this.scheduleNotify();
      }
    }, this.notifyIntervalMs);
  }

  private flushNotify(): void {
    this.snapshotToken += 1;
    for (const l of this.listeners) l();
  }

  /** Drops the pending timer. Called from the provider's effect cleanup. */
  dispose(): void {
    if (this.notifyTimer !== null) {
      clearTimeout(this.notifyTimer);
      this.notifyTimer = null;
    }
    this.listeners.clear();
  }
}

/**
 * Collapse a channel's points inside [from, to] into at most `buckets` columns.
 *
 * This is the level-of-detail step, and it is the single biggest reason the line
 * chart survives 100k points: there is no sense stroking 100k segments into 1200
 * physical pixels. We keep min *and* max per column so spikes that fall between
 * samples still show up — plain decimation makes them flicker in and out as you
 * pan, which looks broken.
 *
 * Writes into caller-owned arrays so the render loop allocates nothing.
 */
export function bucketChannel(
  channel: ChannelBuffer,
  from: number,
  to: number,
  buckets: number,
  outMin: Float32Array,
  outMax: Float32Array,
  outAvg: Float32Array,
  outCount: Uint32Array,
): number {
  outMin.fill(0, 0, buckets);
  outMax.fill(0, 0, buckets);
  outAvg.fill(0, 0, buckets);
  outCount.fill(0, 0, buckets);

  if (channel.size === 0 || to <= from) return 0;

  const start = channel.lowerBound(from);
  const end = channel.upperBound(to);
  if (end <= start) return 0;

  const span = to - from;
  let filled = 0;

  for (let i = start; i < end; i += 1) {
    const t = channel.timeAt(i);
    const v = channel.valueAt(i);
    let b = Math.floor(((t - from) / span) * buckets);
    if (b < 0) b = 0;
    else if (b >= buckets) b = buckets - 1;

    if (outCount[b] === 0) {
      outMin[b] = v;
      outMax[b] = v;
      outAvg[b] = v;
      filled += 1;
    } else {
      if (v < outMin[b]) outMin[b] = v;
      if (v > outMax[b]) outMax[b] = v;
      outAvg[b] += v;
    }
    outCount[b] += 1;
  }

  for (let b = 0; b < buckets; b += 1) {
    if (outCount[b] > 1) outAvg[b] /= outCount[b];
  }

  return filled;
}

/** Object-shaped aggregation for the table and the worker fallback path. */
export function aggregateToBuckets(
  channel: ChannelBuffer,
  from: number,
  to: number,
  windowMs: number,
): AggregatedBucket[] {
  if (channel.size === 0 || windowMs <= 0) return [];
  const start = channel.lowerBound(from);
  const end = channel.upperBound(to);
  const out: AggregatedBucket[] = [];

  let currentBucket = -1;
  let acc: AggregatedBucket | null = null;

  for (let i = start; i < end; i += 1) {
    const t = channel.timeAt(i);
    const v = channel.valueAt(i);
    const b = Math.floor(t / windowMs);
    if (b !== currentBucket) {
      if (acc) {
        acc.avg /= acc.count;
        out.push(acc);
      }
      currentBucket = b;
      acc = { t: b * windowMs, min: v, max: v, avg: v, count: 1 };
    } else if (acc) {
      if (v < acc.min) acc.min = v;
      if (v > acc.max) acc.max = v;
      acc.avg += v;
      acc.count += 1;
    }
  }

  if (acc) {
    acc.avg /= acc.count;
    out.push(acc);
  }

  return out;
}
