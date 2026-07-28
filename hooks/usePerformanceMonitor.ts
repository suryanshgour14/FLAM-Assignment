'use client';

import { useEffect, useRef, useState } from 'react';
import { Ema, FrameSampler, readHeap } from '@/lib/performanceUtils';
import { scheduler } from '@/lib/renderScheduler';
import type { PerformanceMetrics } from '@/lib/types';

const EMPTY: PerformanceMetrics = {
  fps: 0,
  worstFrameMs: 0,
  p95FrameMs: 0,
  memoryUsage: 0,
  memoryLimit: 0,
  renderTime: 0,
  dataProcessingTime: 0,
  droppedFrames: 0,
};

export interface PerfMonitorState extends PerformanceMetrics {
  /** Last 60 FPS readings, for the HUD sparkline. */
  history: Float32Array;
  historyLength: number;
  memorySupported: boolean;
  /** Bytes held by our own typed arrays — always available, unlike heap size. */
  bufferBytes: number;
}

export interface UsePerformanceMonitorOptions {
  /** How often the React state is refreshed. 1Hz is plenty and costs nothing. */
  reportIntervalMs?: number;
  bufferBytes?: () => number;
  enabled?: boolean;
}

const HISTORY = 60;

/**
 * The dashboard's own instrumentation.
 *
 * Two things worth calling out:
 *
 *  1. The sampler runs inside the shared rAF loop, so it measures the same
 *     frames the charts are drawn in. Sampling on a `setInterval` would report
 *     the timer's cadence, not the compositor's.
 *  2. State is published once a second. A monitor that re-renders at 60fps to
 *     tell you that you're at 60fps is measuring itself.
 */
export function usePerformanceMonitor({
  reportIntervalMs = 1000,
  bufferBytes,
  enabled = true,
}: UsePerformanceMonitorOptions = {}): PerfMonitorState {
  const [metrics, setMetrics] = useState<PerformanceMetrics>(EMPTY);
  const [memorySupported, setMemorySupported] = useState(false);
  const [bytes, setBytes] = useState(0);

  const samplerRef = useRef<FrameSampler | null>(null);
  const renderEma = useRef(new Ema(0.15));
  const processEma = useRef(new Ema(0.15));
  const historyRef = useRef(new Float32Array(HISTORY));
  const historyLen = useRef(0);
  const bufferBytesRef = useRef(bufferBytes);
  bufferBytesRef.current = bufferBytes;

  useEffect(() => {
    if (!enabled) return;
    const sampler = new FrameSampler(120);
    samplerRef.current = sampler;

    let lastReport = performance.now();

    const unregister = scheduler.register((frame) => {
      sampler.sample(frame.now);
      renderEma.current.push(scheduler.lastFrameWorkMs);

      if (frame.now - lastReport < reportIntervalMs) return;
      lastReport = frame.now;

      const heap = readHeap();
      const fps = sampler.fps;

      // Shift-in-place. 60 floats once a second; a ring buffer here would be
      // over-engineering.
      const h = historyRef.current;
      if (historyLen.current < HISTORY) {
        h[historyLen.current] = fps;
        historyLen.current += 1;
      } else {
        h.copyWithin(0, 1);
        h[HISTORY - 1] = fps;
      }

      setMemorySupported(heap.supported);
      setBytes(bufferBytesRef.current?.() ?? 0);
      setMetrics({
        fps,
        worstFrameMs: sampler.worst(),
        p95FrameMs: sampler.percentile(95),
        memoryUsage: heap.used,
        memoryLimit: heap.limit,
        renderTime: renderEma.current.value,
        dataProcessingTime: processEma.current.value,
        droppedFrames: sampler.droppedFrames,
      });
    }, 100); // Priority 100 — measure after every chart has drawn.

    return () => {
      unregister();
      samplerRef.current = null;
      renderEma.current.reset();
      processEma.current.reset();
    };
  }, [enabled, reportIntervalMs]);

  /**
   * Picks up `performance.measure('data-processing')` calls emitted by the
   * stream hook and the worker bridge, so the "processing" figure is real
   * User Timing data rather than something we guessed at.
   */
  useEffect(() => {
    if (!enabled || typeof PerformanceObserver === 'undefined') return;
    let observer: PerformanceObserver;
    try {
      observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.entryType === 'measure' && entry.name.startsWith('data-')) {
            processEma.current.push(entry.duration);
          }
        }
      });
      observer.observe({ entryTypes: ['measure'] });
    } catch {
      return;
    }
    return () => observer.disconnect();
  }, [enabled]);

  return {
    ...metrics,
    history: historyRef.current,
    historyLength: historyLen.current,
    memorySupported,
    bufferBytes: bytes,
  };
}
