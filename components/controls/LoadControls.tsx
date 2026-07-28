'use client';

import { memo, useCallback } from 'react';
import styles from './controls.module.css';
import {
  useDashboardActions,
  useDataStore,
  useStoreRevision,
  useStream,
} from '@/components/providers/DataProvider';
import { formatCount } from '@/lib/canvasUtils';
import { CATEGORIES } from '@/lib/types';

/**
 * Data generation controls and the stress test.
 *
 * The capacity presets are expressed as *total* points across all eight
 * channels, because that's the number the brief talks about and the number a
 * reviewer will want to check. Internally each channel gets total/8.
 */

const CAPACITY_PRESETS = [
  { total: 10_000, label: 'baseline' },
  { total: 50_000, label: 'stretch' },
  { total: 100_000, label: 'stretch+' },
  { total: 250_000, label: 'brutal' },
];

const RATE_PRESETS = [
  { ms: 500, label: '2/sec' },
  { ms: 100, label: '10/sec' },
  { ms: 33, label: '30/sec' },
  { ms: 16, label: '60/sec' },
];

function LoadControlsImpl() {
  const { settings, stats, isBackfilling } = useStream();
  const { store } = useDataStore();
  useStoreRevision();
  const actions = useDashboardActions();

  const totalCapacity = settings.capacity * CATEGORIES.length;
  const perChannel = useCallback((total: number) => Math.max(256, Math.round(total / CATEGORIES.length)), []);

  return (
    <>
      <div className={styles.section}>
        <div className={styles.sectionHead}>
          <span className={styles.label}>Buffer size</span>
          {isBackfilling ? (
            <span className={styles.pendingBadge}>
              <span className={styles.pendingDot} />
              filling
            </span>
          ) : (
            <span className={styles.sliderValue}>{formatCount(store.pointCount)} held</span>
          )}
        </div>
        <div className={styles.presets}>
          {CAPACITY_PRESETS.map((p) => (
            <button
              key={p.total}
              type="button"
              // Stable hook for the benchmark harness — see scripts/benchmark.mjs.
              // Selecting these by visible text is brittle: "50.0k" is a
              // substring of the "250.0k" label and of the live "held" readout.
              data-preset={p.total}
              className={`${styles.preset} ${totalCapacity === p.total ? styles.presetActive : ''}`}
              // Presets fill immediately. A buffer sized for 100k that holds 10k
              // demonstrates nothing, and waiting 20 minutes for it to fill at
              // the spec'd rate is not a demo.
              onClick={() => actions.setCapacityAndFill(perChannel(p.total))}
              aria-pressed={totalCapacity === p.total}
              disabled={isBackfilling}
            >
              <span className={styles.presetValue}>{formatCount(p.total)}</span>
              <span className={styles.presetLabel}>{p.label}</span>
            </button>
          ))}
        </div>

        <div className={styles.slider}>
          <div className={styles.sliderHead}>
            <span>Fine tune</span>
            <span className={styles.sliderValue}>{formatCount(totalCapacity)} pts</span>
          </div>
          <input
            type="range"
            min={2_000}
            max={400_000}
            step={2_000}
            value={totalCapacity}
            // The slider only resizes — dragging it would otherwise kick off a
            // backfill on every intermediate value.
            onChange={(e) => actions.setCapacity(perChannel(Number(e.target.value)))}
            onPointerUp={() => actions.setCapacityAndFill(perChannel(totalCapacity))}
            aria-label="Total buffer capacity in points"
          />
        </div>
      </div>

      <div className={styles.section}>
        <div className={styles.sectionHead}>
          <span className={styles.label}>Update rate</span>
          <span className={styles.sliderValue}>{formatCount(stats.pointsPerSecond)} pts/s</span>
        </div>
        <div className={styles.segmented} role="group" aria-label="Update rate">
          {RATE_PRESETS.map((r) => (
            <button
              key={r.ms}
              type="button"
              className={`${styles.segment} ${settings.intervalMs === r.ms ? styles.segmentActive : ''}`}
              onClick={() => actions.setIntervalMs(r.ms)}
              aria-pressed={settings.intervalMs === r.ms}
            >
              {r.label}
            </button>
          ))}
        </div>

        <div className={styles.slider}>
          <div className={styles.sliderHead}>
            <span>Points per tick</span>
            <span className={styles.sliderValue}>{settings.batchSize}</span>
          </div>
          <input
            type="range"
            min={CATEGORIES.length}
            max={800}
            step={CATEGORIES.length}
            value={settings.batchSize}
            onChange={(e) => actions.setBatchSize(Number(e.target.value))}
            aria-label="Points generated per tick"
          />
        </div>
      </div>

      <div className={styles.section}>
        <span className={styles.label}>Stream</span>
        <div className={styles.buttonRow}>
          <button
            type="button"
            data-action="toggle-stream"
            className={`${styles.btn} ${settings.running ? '' : styles.btnPrimary}`}
            onClick={() => actions.setRunning(!settings.running)}
          >
            {settings.running ? (
              <>
                <PauseIcon /> Pause
              </>
            ) : (
              <>
                <PlayIcon /> Resume
              </>
            )}
          </button>
          <button type="button" className={`${styles.btn} ${styles.btnDanger}`} onClick={actions.clearData}>
            Clear
          </button>
          <button
            type="button"
            data-action="stress"
            className={`${styles.btn} ${styles.btnWide} ${
              settings.stressMode ? `${styles.btnDanger} ${styles.stressActive}` : styles.btnPrimary
            }`}
            onClick={actions.toggleStressMode}
            aria-pressed={settings.stressMode}
          >
            {settings.stressMode ? 'Stop stress test' : 'Run stress test'}
          </button>
        </div>
        <p className={styles.note}>
          Stress mode drives 240 points every 16ms — roughly 15,000 points/sec, well past the
          brief&apos;s 100ms cadence. Watch the frame-time percentile rather than the FPS average;
          it is the number that exposes jank.
        </p>
      </div>
    </>
  );
}

function PauseIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor" aria-hidden="true">
      <rect x="1" y="1" width="3" height="8" rx="1" />
      <rect x="6" y="1" width="3" height="8" rx="1" />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor" aria-hidden="true">
      <path d="M2 1.5v7l6.5-3.5z" />
    </svg>
  );
}

export const LoadControls = memo(LoadControlsImpl);
export default LoadControls;
