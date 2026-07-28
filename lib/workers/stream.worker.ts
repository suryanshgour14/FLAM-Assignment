/// <reference lib="webworker" />

import { CATEGORIES } from '../types';
import { createWalkers, type SeriesWalker } from '../dataGenerator';

/**
 * Generation + aggregation, off the main thread.
 *
 * At the spec'd 100ms / 8-points-per-tick this is honestly overkill — the maths
 * is a few microseconds. It earns its keep in stress mode, where a tick can be
 * 500 points and the Gaussian sampling starts showing up in a profile, and in
 * the aggregation path, where the table asks for a full re-bucket of 100k
 * points on every filter change.
 *
 * Results come back on transferable ArrayBuffers, so the handoff is a pointer
 * move rather than a structured clone of the payload.
 */

export interface InitMessage {
  type: 'init';
  seed: number;
}

export interface GenerateMessage {
  type: 'generate';
  /** Monotonic tick index — keeps the seasonal term continuous. */
  tick: number;
  timestamp: number;
  intervalMs: number;
  /** Samples per category in this batch. */
  perCategory: number;
}

export interface AggregateMessage {
  type: 'aggregate';
  requestId: number;
  timestamps: ArrayBuffer;
  values: ArrayBuffer;
  windowMs: number;
}

/**
 * Fill the buffer with plausible history, right now.
 *
 * Without this, raising the buffer to 100k at the spec'd 80 points/second means
 * waiting twenty minutes to see a full buffer — so nobody would ever actually
 * look at the dashboard under the load it was built for.
 *
 * The trick is that the walk is deterministic and stateful. We run a fresh
 * walker set forward N ticks to manufacture the history, stamp it ending at
 * "now", and then *keep those walkers* as the live ones. The stream continues
 * from exactly where the backfill stopped, so there is no seam at the join.
 */
export interface BackfillMessage {
  type: 'backfill';
  perCategory: number;
  endTime: number;
  intervalMs: number;
}

/**
 * Hands the batch buffers back so they can be written into again.
 *
 * Without this the worker allocates three fresh ArrayBuffers per tick. At the
 * spec'd 100ms cadence that is 30 allocations a second and nobody would ever
 * notice. In stress mode it is ~190 a second — roughly 570 KB/s of garbage —
 * and it showed up as two distinct symptoms: a heap that climbed ~200 MB/hour,
 * and periodic 60–100ms frames that were nothing but major GC pauses. The
 * median frame was fine; the p95 was ruined.
 *
 * Transferring the buffers back is free (it's a pointer move, not a copy), and
 * it takes the steady-state allocation rate for the streaming path to zero.
 */
export interface RecycleMessage {
  type: 'recycle';
  timestamps: ArrayBuffer;
  values: ArrayBuffer;
  categories: ArrayBuffer;
}

export type WorkerRequest =
  | InitMessage
  | GenerateMessage
  | AggregateMessage
  | BackfillMessage
  | RecycleMessage;

export interface GeneratedBatch {
  type: 'batch' | 'backfill-batch';
  tick: number;
  timestamps: ArrayBuffer;
  values: ArrayBuffer;
  categories: ArrayBuffer;
  count: number;
  /** Time spent generating, reported so the HUD can show real numbers. */
  elapsedMs: number;
  /** Next tick index the live stream should continue from. */
  nextTick?: number;
}

export interface AggregatedResult {
  type: 'aggregated';
  requestId: number;
  bucketTimes: ArrayBuffer;
  bucketAvg: ArrayBuffer;
  bucketMin: ArrayBuffer;
  bucketMax: ArrayBuffer;
  count: number;
  elapsedMs: number;
}

export type WorkerResponse = GeneratedBatch | AggregatedResult | { type: 'ready' };

const ctx = self as unknown as DedicatedWorkerGlobalScope;

let walkers: SeriesWalker[] = createWalkers(20240607);
let seed = 20240607;

function backfill(msg: BackfillMessage): GeneratedBatch {
  const started = performance.now();
  const n = CATEGORIES.length;
  const steps = msg.perCategory;
  const total = steps * n;

  const timestamps = new Float64Array(total);
  const values = new Float32Array(total);
  const categories = new Uint8Array(total);

  // Fresh walkers, run forward to manufacture the history.
  const fresh = createWalkers(seed);
  let w = 0;
  for (let s = 0; s < steps; s += 1) {
    const t = msg.endTime - (steps - 1 - s) * msg.intervalMs;
    for (let c = 0; c < n; c += 1) {
      timestamps[w] = t;
      values[w] = fresh[c].next(s);
      categories[w] = c;
      w += 1;
    }
  }

  // Adopt them, so the live stream picks up exactly where this left off.
  walkers = fresh;

  return {
    type: 'backfill-batch',
    tick: steps,
    nextTick: steps,
    timestamps: timestamps.buffer,
    values: values.buffer,
    categories: categories.buffer,
    count: total,
    elapsedMs: performance.now() - started,
  };
}

/**
 * Free list of recycled buffers, keyed implicitly by byte length.
 *
 * Capped: the batch size is user-adjustable, so without a bound the pool would
 * accumulate one entry per size the slider ever passed through.
 */
const pool: ArrayBuffer[] = [];
const POOL_MAX = 12;

function take(bytes: number): ArrayBuffer {
  for (let i = 0; i < pool.length; i += 1) {
    if (pool[i].byteLength === bytes) return pool.splice(i, 1)[0];
  }
  return new ArrayBuffer(bytes);
}

function give(buffer: ArrayBuffer): void {
  // A detached buffer (already transferred elsewhere) is useless to us.
  if (buffer.byteLength === 0) return;
  if (pool.length >= POOL_MAX) pool.shift();
  pool.push(buffer);
}

function generate(msg: GenerateMessage): GeneratedBatch {
  const started = performance.now();
  const total = msg.perCategory * CATEGORIES.length;

  // Every slot is written below, so a recycled buffer needs no zeroing.
  const timestamps = new Float64Array(take(total * 8));
  const values = new Float32Array(take(total * 4));
  const categories = new Uint8Array(take(total));

  let w = 0;
  for (let s = 0; s < msg.perCategory; s += 1) {
    // Spread a multi-sample batch across the interval instead of stacking every
    // point on the same millisecond — otherwise the x-axis goes stair-stepped
    // under stress mode.
    const t = msg.timestamp - (msg.perCategory - 1 - s) * (msg.intervalMs / msg.perCategory);
    for (let c = 0; c < walkers.length; c += 1) {
      timestamps[w] = t;
      values[w] = walkers[c].next(msg.tick + s);
      categories[w] = c;
      w += 1;
    }
  }

  return {
    type: 'batch',
    tick: msg.tick,
    timestamps: timestamps.buffer,
    values: values.buffer,
    categories: categories.buffer,
    count: total,
    elapsedMs: performance.now() - started,
  };
}

function aggregate(msg: AggregateMessage): AggregatedResult {
  const started = performance.now();
  const ts = new Float64Array(msg.timestamps);
  const vs = new Float32Array(msg.values);
  const windowMs = msg.windowMs;

  const times: number[] = [];
  const avgs: number[] = [];
  const mins: number[] = [];
  const maxs: number[] = [];

  let bucket = -1;
  let sum = 0;
  let count = 0;
  let min = 0;
  let max = 0;

  for (let i = 0; i < ts.length; i += 1) {
    const b = Math.floor(ts[i] / windowMs);
    const v = vs[i];
    if (b !== bucket) {
      if (count > 0) {
        times.push(bucket * windowMs);
        avgs.push(sum / count);
        mins.push(min);
        maxs.push(max);
      }
      bucket = b;
      sum = v;
      count = 1;
      min = v;
      max = v;
    } else {
      sum += v;
      count += 1;
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  if (count > 0) {
    times.push(bucket * windowMs);
    avgs.push(sum / count);
    mins.push(min);
    maxs.push(max);
  }

  const bucketTimes = Float64Array.from(times);
  const bucketAvg = Float32Array.from(avgs);
  const bucketMin = Float32Array.from(mins);
  const bucketMax = Float32Array.from(maxs);

  return {
    type: 'aggregated',
    requestId: msg.requestId,
    bucketTimes: bucketTimes.buffer,
    bucketAvg: bucketAvg.buffer,
    bucketMin: bucketMin.buffer,
    bucketMax: bucketMax.buffer,
    count: times.length,
    elapsedMs: performance.now() - started,
  };
}

ctx.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data;

  switch (msg.type) {
    case 'init': {
      seed = msg.seed;
      walkers = createWalkers(msg.seed);
      ctx.postMessage({ type: 'ready' } satisfies WorkerResponse);
      break;
    }
    case 'backfill': {
      const batch = backfill(msg);
      ctx.postMessage(batch, [batch.timestamps, batch.values, batch.categories]);
      break;
    }
    case 'generate': {
      const batch = generate(msg);
      ctx.postMessage(batch, [batch.timestamps, batch.values, batch.categories]);
      break;
    }
    case 'recycle': {
      give(msg.timestamps);
      give(msg.values);
      give(msg.categories);
      break;
    }
    case 'aggregate': {
      const result = aggregate(msg);
      ctx.postMessage(result, [
        result.bucketTimes,
        result.bucketAvg,
        result.bucketMin,
        result.bucketMax,
      ]);
      break;
    }
  }
};

export {};
