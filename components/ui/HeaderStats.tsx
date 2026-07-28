'use client';

import { memo } from 'react';
import styles from '@/app/dashboard/dashboard.module.css';
import { useDataStore, useStream } from '@/components/providers/DataProvider';
import { usePerformanceMonitor } from '@/hooks/usePerformanceMonitor';
import { formatCount } from '@/lib/canvasUtils';
import { fpsGrade } from '@/lib/performanceUtils';

/**
 * The always-visible pills in the header.
 *
 * This subscribes to the perf monitor independently of the sidebar panel. That
 * means two `usePerformanceMonitor` instances, which sounds wasteful until you
 * consider the alternative: hoisting metrics into a shared context would put a
 * 1Hz state change above the entire dashboard tree. Two lightweight samplers
 * cost less than one badly placed provider.
 */
function HeaderStatsImpl() {
  const { store } = useDataStore();
  const { stats, settings } = useStream();
  const m = usePerformanceMonitor({ reportIntervalMs: 500 });

  const grade = fpsGrade(m.fps);
  const gradeClass =
    grade === 'good' ? styles.statGood : grade === 'ok' ? styles.statOk : styles.statBad;

  return (
    <div className={styles.headerStats}>
      <span className={styles.stat}>
        <span className={styles.statLabel}>Points</span>
        <span className={styles.statValue}>{formatCount(store.pointCount)}</span>
      </span>
      <span className={styles.stat}>
        <span className={styles.statLabel}>Rate</span>
        <span className={styles.statValue}>{formatCount(stats.pointsPerSecond)}/s</span>
      </span>
      <span className={styles.stat}>
        <span className={styles.statLabel}>Frame</span>
        <span className={styles.statValue}>{m.p95FrameMs.toFixed(1)}ms</span>
      </span>
      <span className={styles.stat}>
        <span className={styles.statLabel}>{settings.stressMode ? 'Stress' : 'FPS'}</span>
        <span className={`${styles.statValue} ${gradeClass}`}>{m.fps.toFixed(0)}</span>
      </span>
    </div>
  );
}

export const HeaderStats = memo(HeaderStatsImpl);
export default HeaderStats;
