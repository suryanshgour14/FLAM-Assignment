'use client';

import { memo, useCallback, useMemo } from 'react';
import styles from './ui.module.css';
import { useDataStore, useStream } from '@/components/providers/DataProvider';
import { usePerformanceMonitor } from '@/hooks/usePerformanceMonitor';
import { formatBytes, formatCount } from '@/lib/canvasUtils';
import { fpsGrade } from '@/lib/performanceUtils';

/**
 * The instrumentation panel.
 *
 * Two decisions worth defending:
 *
 *   1. **p95 frame time is shown next to FPS, not instead of it.** Average FPS
 *      is the number people ask for and the number that hides everything —
 *      59fps with one 180ms stall averages out fine and feels terrible. The
 *      percentile is what actually tracks perceived smoothness.
 *   2. **Heap is labelled honestly.** `performance.memory` only exists in
 *      Chromium, so on Firefox and Safari the panel reports the size of our own
 *      typed arrays instead and says so, rather than showing a confident zero.
 */
function PerformanceMonitorImpl() {
  const { store } = useDataStore();
  const { stats, settings } = useStream();

  const bufferBytes = useCallback(() => store.approximateBytes(), [store]);
  const m = usePerformanceMonitor({ bufferBytes });

  const grade = fpsGrade(m.fps);
  const frameGrade = m.p95FrameMs === 0 ? 'good' : m.p95FrameMs < 18 ? 'good' : m.p95FrameMs < 34 ? 'ok' : 'bad';

  return (
    <div className={styles.perf}>
      {/* `data-metric` attributes are read by scripts/benchmark.mjs. Parsing
          rendered text was fragile — "50.0k" appears in three unrelated places
          on this page — and structured hooks make the numbers in
          PERFORMANCE.md reproducible rather than anecdotal. */}
      <div className={styles.perfGrid}>
        <div className={styles.metric}>
          <div className={styles.metricLabel}>Frame rate</div>
          <div className={`${styles.metricValue} ${styles[grade]}`} data-metric="fps" data-value={m.fps}>
            {m.fps.toFixed(0)}
            <span className={styles.metricUnit}>fps</span>
          </div>
          <div className={styles.metricSub} data-metric="dropped" data-value={m.droppedFrames}>
            {m.droppedFrames} dropped
          </div>
        </div>

        <div className={styles.metric}>
          <div className={styles.metricLabel}>Frame time p95</div>
          <div
            className={`${styles.metricValue} ${styles[frameGrade]}`}
            data-metric="p95"
            data-value={m.p95FrameMs}
          >
            {m.p95FrameMs.toFixed(1)}
            <span className={styles.metricUnit}>ms</span>
          </div>
          <div className={styles.metricSub} data-metric="worst" data-value={m.worstFrameMs}>
            worst {m.worstFrameMs.toFixed(0)}ms
          </div>
        </div>

        <div className={styles.metric}>
          <div className={styles.metricLabel}>{m.memorySupported ? 'JS heap' : 'Buffer memory'}</div>
          <div
            className={styles.metricValue}
            data-metric="heap"
            data-value={m.memorySupported ? m.memoryUsage : m.bufferBytes}
          >
            {formatBytes(m.memorySupported ? m.memoryUsage : m.bufferBytes)}
          </div>
          <div className={styles.metricSub}>
            {m.memorySupported ? `of ${formatBytes(m.memoryLimit)}` : 'typed arrays'}
          </div>
        </div>

        <div className={styles.metric}>
          <div className={styles.metricLabel}>Points held</div>
          <div className={styles.metricValue} data-metric="points" data-value={store.pointCount}>
            {formatCount(store.pointCount)}
          </div>
          <div className={styles.metricSub} data-metric="rate" data-value={stats.pointsPerSecond}>
            {formatCount(stats.pointsPerSecond)}/s in
          </div>
        </div>
      </div>

      <div className={styles.sparkWrap}>
        <div className={styles.sparkHead}>
          <span className={styles.metricLabel}>FPS · last {m.historyLength}s</span>
          <span className={styles.perfRowValue}>60 target</span>
        </div>
        <Sparkline values={m.history} length={m.historyLength} />
      </div>

      <div>
        <div className={styles.perfRow}>
          <span>Canvas work / frame</span>
          <span className={styles.perfRowValue} data-metric="canvasMs" data-value={m.renderTime}>
            {m.renderTime.toFixed(2)} ms
          </span>
        </div>
        <div className={styles.perfRow}>
          <span>Data processing</span>
          <span className={styles.perfRowValue} data-metric="dataMs" data-value={m.dataProcessingTime}>
            {m.dataProcessingTime.toFixed(2)} ms
          </span>
        </div>
        <div className={styles.perfRow}>
          <span>Ingest per tick</span>
          <span className={styles.perfRowValue} data-metric="ingestMs" data-value={stats.lastTickMs}>
            {stats.lastTickMs.toFixed(2)} ms
          </span>
        </div>
        <div className={styles.perfRow}>
          <span>Generation thread</span>
          <span
            className={`${styles.perfRowValue} ${stats.workerActive ? styles.good : styles.ok}`}
            data-metric="thread"
            data-value={stats.workerActive ? 'worker' : 'main'}
          >
            {stats.workerActive ? 'Web Worker' : 'main thread'}
          </span>
        </div>
        <div className={styles.perfRow}>
          <span>Total ingested</span>
          <span className={styles.perfRowValue}>{formatCount(stats.totalIngested)}</span>
        </div>
        <div className={styles.perfRow}>
          <span>Buffer capacity</span>
          <span className={styles.perfRowValue}>{formatCount(settings.capacity * 8)}</span>
        </div>
      </div>

      {!m.memorySupported && (
        <p className={styles.warnNote}>
          performance.memory is Chromium-only. On this browser the panel reports the size of the
          dashboard&apos;s own typed arrays instead of the JS heap.
        </p>
      )}
    </div>
  );
}

/**
 * SVG rather than canvas, deliberately.
 *
 * It's ~60 points redrawn once a second. Canvas would mean another context,
 * another entry in the frame loop and DPR handling, to save a polyline the
 * browser renders for free. Use the right tool for the density — that's the
 * whole point of the hybrid approach.
 */
const Sparkline = memo(function Sparkline({
  values,
  length,
}: {
  values: Float32Array;
  length: number;
}) {
  const { path, area } = useMemo(() => {
    if (length < 2) return { path: '', area: '' };
    const W = 100;
    const H = 34;
    const max = 75;
    let d = '';
    for (let i = 0; i < length; i += 1) {
      const x = (i / (length - 1)) * W;
      const y = H - Math.min(1, values[i] / max) * H;
      d += `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`;
    }
    return { path: d, area: `${d}L${W},${H}L0,${H}Z` };
  }, [values, length]);

  if (!path) {
    return <div className={styles.spark} />;
  }

  // 60fps reference line at y = 34 - (60/75)*34.
  const targetY = 34 - (60 / 75) * 34;

  return (
    <svg
      className={styles.spark}
      viewBox="0 0 100 34"
      preserveAspectRatio="none"
      role="img"
      aria-label="Frame rate over the last minute"
    >
      <defs>
        <linearGradient id="sparkFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#6ea8fe" stopOpacity="0.32" />
          <stop offset="100%" stopColor="#6ea8fe" stopOpacity="0" />
        </linearGradient>
      </defs>
      <line
        x1="0"
        y1={targetY}
        x2="100"
        y2={targetY}
        stroke="rgba(74,222,128,0.3)"
        strokeWidth="0.5"
        strokeDasharray="2 2"
        vectorEffect="non-scaling-stroke"
      />
      <path d={area} fill="url(#sparkFill)" />
      <path
        d={path}
        fill="none"
        stroke="#6ea8fe"
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
});

export const PerformanceMonitor = memo(PerformanceMonitorImpl);
export default PerformanceMonitor;
