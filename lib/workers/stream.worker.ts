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

export type WorkerRequest = InitMessage | GenerateMessage | AggregateMessage;

export interface GeneratedBatch {
  type: 'batch';
  tick: number;
  timestamps: ArrayBuffer;
  values: ArrayBuffer;
  categories: ArrayBuffer;
  count: number;
  /** Time spent generating, reported so the HUD can show real numbers. */
  elapsedMs: number;
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

function generate(msg: GenerateMessage): GeneratedBatch {
  const started = performance.now();
  const total = msg.perCategory * CATEGORIES.length;

  const timestamps = new Float64Array(total);
  const values = new Float32Array(total);
  const categories = new Uint8Array(total);

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
      walkers = createWalkers(msg.seed);
      ctx.postMessage({ type: 'ready' } satisfies WorkerResponse);
      break;
    }
    case 'generate': {
      const batch = generate(msg);
      ctx.postMessage(batch, [batch.timestamps, batch.values, batch.categories]);
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
