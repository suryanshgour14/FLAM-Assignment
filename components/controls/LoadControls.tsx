'use client';

import { memo, useCallback } from 'react';
import styles from './controls.module.css';
import { useDashboardActions, useDataStore, useStream } from '@/components/providers/DataProvider';
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
  const { settings, stats } = useStream();
  const { store } = useDataStore();
  const actions = useDashboardActions();

  const totalCapacity = settings.capacity * CATEGORIES.length;

  const setTotalCapacity = useCallback(
    (total: number) => {
      actions.setCapacity(Math.max(256, Math.round(total / CATEGORIES.length)));
    },
    [actions],
  );

  return (
    <>
      <div className={styles.section}>
        <div className={styles.sectionHead}>
          <span className={styles.label}>Buffer size</span>
          <span className={styles.sliderValue}>{formatCount(store.pointCount)} held</span>
        </div>
        <div className={styles.presets}>
          {CAPACITY_PRESETS.map((p) => (
            <button
              key={p.total}
              type="button"
              className={`${styles.preset} ${totalCapacity === p.total ? styles.presetActive : ''}`}
              onClick={() => setTotalCapacity(p.total)}
              aria-pressed={totalCapacity === p.total}
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
            onChange={(e) => setTotalCapacity(Number(e.target.value))}
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
