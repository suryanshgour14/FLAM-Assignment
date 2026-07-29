'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { CATEGORIES, type StreamSettings } from '@/lib/types';
import { createWalkers, type SeriesWalker } from '@/lib/dataGenerator';
import { perfBus } from '@/lib/perfBus';
import type { DataStore } from '@/lib/seriesBuffer';
import type { GeneratedBatch, WorkerRequest } from '@/lib/workers/stream.worker';

export interface StreamStats {
  /** Points appended per second, measured rather than assumed. */
  pointsPerSecond: number;
  totalIngested: number;
  lastTickMs: number;
  workerActive: boolean;
  ticks: number;
}

export interface UseDataStreamOptions {
  store: DataStore;
  settings: StreamSettings;
  seed: number;
  /** Start tick offset so the client stream continues the server's series. */
  startTick: number;
  onBatch?: (count: number) => void;
}

export interface StreamControls {
  /**
   * Fill the buffer to capacity with plausible history immediately.
   *
   * Raising the buffer to 100k at the spec'd 80 points/second would otherwise
   * take twenty minutes to show anything, which means the load controls would
   * be untestable in a demo.
   */
  backfill: (perCategory: number) => void;
  isBackfilling: boolean;
}

const IDLE_STATS: StreamStats = {
  pointsPerSecond: 0,
  totalIngested: 0,
  lastTickMs: 0,
  workerActive: false,
  ticks: 0,
};

/**
 * Drives the live data feed.
 *
 * The critical property: **this hook never re-renders on data arrival.** It
 * writes into the store's typed arrays and bumps a version counter. Charts see
 * the new data because their rAF loop reads that counter — not because React
 * told them anything. That is the whole reason the dashboard holds 60fps while
 * ingesting; a `setState` per tick would put a full reconciliation between
 * every frame.
 *
 * Stats *are* published to React, but on a 1Hz timer, which is 1/10th of the
 * data rate and invisible in a profile.
 */
export function useDataStream({
  store,
  settings,
  seed,
  startTick,
  onBatch,
}: UseDataStreamOptions): StreamStats & StreamControls {
  const [stats, setStats] = useState<StreamStats>(IDLE_STATS);
  const [isBackfilling, setBackfilling] = useState(false);

  const workerRef = useRef<Worker | null>(null);
  const workerReady = useRef(false);
  const walkersRef = useRef<SeriesWalker[] | null>(null);
  const tickRef = useRef(startTick);
  const ingestedInWindow = useRef(0);
  const windowStart = useRef(0);
  const lastTickMs = useRef(0);
  const tickCount = useRef(0);
  const onBatchRef = useRef(onBatch);
  onBatchRef.current = onBatch;
  const backfillFrame = useRef<number | null>(null);

  // Live mirror of settings, so the interval callback always reads current
  // values without the interval having to be torn down and recreated.
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  /** Copies a worker batch into the ring buffers. Pure memory traffic, no allocation. */
  const ingest = useCallback(
    (timestamps: Float64Array, values: Float32Array, categories: Uint8Array, count: number) => {
      const t0 = performance.now();
      for (let i = 0; i < count; i += 1) {
        store.pushAt(categories[i], timestamps[i], values[i]);
      }
      store.commit(Date.now());
      ingestedInWindow.current += count;
      tickCount.current += 1;
      const elapsed = performance.now() - t0;
      lastTickMs.current = elapsed;
      perfBus.recordIngest(elapsed, count);
      onBatchRef.current?.(count);
    },
    [store],
  );

  // ---- Worker bootstrap -----------------------------------------------------
  useEffect(() => {
    if (typeof Worker === 'undefined') return;

    let worker: Worker;
    try {
      worker = new Worker(new URL('../lib/workers/stream.worker.ts', import.meta.url), {
        type: 'module',
      });
    } catch {
      // Older Safari and a couple of embedded webviews reject module workers.
      // Not fatal — the main-thread path below covers it.
      return;
    }

    worker.onmessage = (event: MessageEvent<GeneratedBatch | { type: 'ready' }>) => {
      const msg = event.data;
      if (msg.type === 'ready') {
        workerReady.current = true;
        return;
      }
      if (msg.type === 'batch') {
        // No performance.mark() here — see lib/perfBus.ts. At 62 ticks/second
        // the User Timing calls cost more than the ingest they were timing.
        perfBus.recordDataProcessing(msg.elapsedMs);
        ingest(
          new Float64Array(msg.timestamps),
          new Float32Array(msg.values),
          new Uint8Array(msg.categories),
          msg.count,
        );
        // Hand the buffers straight back. The views above are detached by the
        // transfer, which is fine — ingest has already copied everything into
        // the ring buffers. This is what keeps the streaming path allocation-
        // free in steady state; see the note on RecycleMessage.
        worker.postMessage(
          {
            type: 'recycle',
            timestamps: msg.timestamps,
            values: msg.values,
            categories: msg.categories,
          } satisfies WorkerRequest,
          [msg.timestamps, msg.values, msg.categories],
        );
        return;
      }

      if (msg.type === 'backfill-batch') {
        // A 250k backfill written in one go is a ~120ms frame — visible as a
        // hitch right when the user clicks. Spreading it over animation frames
        // keeps every individual frame inside budget; the fill takes a few
        // hundred milliseconds of wall clock and nobody notices.
        const timestamps = new Float64Array(msg.timestamps);
        const values = new Float32Array(msg.values);
        const categories = new Uint8Array(msg.categories);
        const CHUNK = 20_000;
        let cursor = 0;

        const step = () => {
          const end = Math.min(msg.count, cursor + CHUNK);
          for (let i = cursor; i < end; i += 1) {
            store.pushAt(categories[i], timestamps[i], values[i]);
          }
          cursor = end;
          store.commit(Date.now());
          if (cursor < msg.count) {
            backfillFrame.current = requestAnimationFrame(step);
          } else {
            backfillFrame.current = null;
            if (msg.nextTick !== undefined) tickRef.current = msg.nextTick;
            setBackfilling(false);
          }
        };
        backfillFrame.current = requestAnimationFrame(step);
      }
    };

    worker.onerror = () => {
      workerReady.current = false;
    };

    worker.postMessage({ type: 'init', seed } satisfies WorkerRequest);
    workerRef.current = worker;

    return () => {
      workerReady.current = false;
      workerRef.current = null;
      worker.onmessage = null;
      worker.onerror = null;
      worker.terminate();
      // A backfill in flight holds a reference to the store through its rAF
      // closure; leaving it scheduled past unmount is a leak with a heartbeat.
      if (backfillFrame.current !== null) {
        cancelAnimationFrame(backfillFrame.current);
        backfillFrame.current = null;
      }
    };
  }, [seed, ingest, store]);

  // Main-thread walkers: both the fallback and what the worker's numbers must
  // match, so they share the same seed and constructor.
  useEffect(() => {
    walkersRef.current = createWalkers(seed);
    tickRef.current = startTick;
    // startTick is intentionally read once — re-seeding mid-stream would put a
    // visible discontinuity in every series.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed]);

  // ---- The tick -------------------------------------------------------------
  useEffect(() => {
    if (!settings.running) return;

    const emit = () => {
      const cfg = settingsRef.current;
      const perCategory = Math.max(1, Math.round(cfg.batchSize / CATEGORIES.length));
      const now = Date.now();
      const tick = tickRef.current;
      tickRef.current += perCategory;

      const worker = workerRef.current;
      if (worker && workerReady.current) {
        worker.postMessage({
          type: 'generate',
          tick,
          timestamp: now,
          intervalMs: cfg.intervalMs,
          perCategory,
        } satisfies WorkerRequest);
        return;
      }

      // Fallback: generate inline. Same numbers, just on this thread.
      const walkers = walkersRef.current;
      if (!walkers) return;
      const t0 = performance.now();
      for (let s = 0; s < perCategory; s += 1) {
        const t = now - (perCategory - 1 - s) * (cfg.intervalMs / perCategory);
        for (let c = 0; c < walkers.length; c += 1) {
          store.pushAt(c, t, walkers[c].next(tick + s));
        }
      }
      store.commit(now);
      const written = perCategory * CATEGORIES.length;
      ingestedInWindow.current += written;
      tickCount.current += 1;
      const elapsed = performance.now() - t0;
      lastTickMs.current = elapsed;
      perfBus.recordIngest(elapsed, written);
      perfBus.recordDataProcessing(elapsed);
      onBatchRef.current?.(written);
    };

    const id = setInterval(emit, settings.intervalMs);
    emit();

    return () => clearInterval(id);
  }, [settings.running, settings.intervalMs, store]);

  // ---- 1Hz stats publication ------------------------------------------------
  useEffect(() => {
    windowStart.current = performance.now();
    const id = setInterval(() => {
      const now = performance.now();
      const elapsed = (now - windowStart.current) / 1000;
      const pps = elapsed > 0 ? ingestedInWindow.current / elapsed : 0;
      ingestedInWindow.current = 0;
      windowStart.current = now;

      // Skip the dispatch entirely when nothing moved — a paused stream would
      // otherwise push an identical object once a second forever, and every one
      // of those is an allocation plus a queue entry before React can discard it.
      setStats((prev) =>
        prev.pointsPerSecond === Math.round(pps) &&
        prev.totalIngested === store.totalIngested &&
        prev.workerActive === workerReady.current
          ? prev
          : {
              pointsPerSecond: Math.round(pps),
              totalIngested: store.totalIngested,
              lastTickMs: lastTickMs.current,
              workerActive: workerReady.current,
              ticks: tickCount.current,
            },
      );
    }, 1000);

    return () => clearInterval(id);
  }, [store]);

  const backfill = useCallback(
    (perCategory: number) => {
      const worker = workerRef.current;
      if (!worker || !workerReady.current || backfillFrame.current !== null) return;
      setBackfilling(true);
      store.clear();
      worker.postMessage({
        type: 'backfill',
        perCategory,
        endTime: Date.now(),
        intervalMs: 100,
      } satisfies WorkerRequest);
    },
    [store],
  );

  return { ...stats, backfill, isBackfilling };
}
