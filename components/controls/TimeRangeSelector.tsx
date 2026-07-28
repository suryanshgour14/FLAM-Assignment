'use client';

import { memo } from 'react';
import styles from './controls.module.css';
import { useDashboardActions, useFilters, useStream } from '@/components/providers/DataProvider';
import { AGGREGATION_WINDOWS, TIME_RANGES } from '@/lib/types';

/**
 * Time range + aggregation window.
 *
 * Both of these can force a full re-bucket of the visible range, so both are
 * dispatched inside `startTransition` (see DataProvider). The pending indicator
 * here is the visible half of that contract — the button highlights instantly,
 * and a small marker admits that the heavy work is still landing.
 */
function TimeRangeSelectorImpl() {
  const filters = useFilters();
  const actions = useDashboardActions();
  const { isPending } = useStream();

  return (
    <>
      <div className={styles.section}>
        <div className={styles.sectionHead}>
          <span className={styles.label}>Time range</span>
          {isPending && (
            <span className={styles.pendingBadge}>
              <span className={styles.pendingDot} />
              applying
            </span>
          )}
        </div>
        <div className={styles.segmented} role="group" aria-label="Time range">
          {TIME_RANGES.map((r) => (
            <button
              key={r.id}
              type="button"
              className={`${styles.segment} ${filters.timeRange === r.id ? styles.segmentActive : ''}`}
              onClick={() => actions.setTimeRange(r.id)}
              aria-pressed={filters.timeRange === r.id}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      <div className={styles.section}>
        <span className={styles.label}>Aggregation</span>
        <div className={styles.segmented} role="group" aria-label="Aggregation window">
          {AGGREGATION_WINDOWS.map((w) => (
            <button
              key={w.id}
              type="button"
              className={`${styles.segment} ${filters.aggregation === w.id ? styles.segmentActive : ''}`}
              onClick={() => actions.setAggregation(w.id)}
              aria-pressed={filters.aggregation === w.id}
            >
              {w.label}
            </button>
          ))}
        </div>
        <p className={styles.note}>
          Groups samples into fixed buckets for the bar chart and the table. “Raw” lets the bar
          chart pick a bucket size that fits the available width.
        </p>
      </div>
    </>
  );
}

export const TimeRangeSelector = memo(TimeRangeSelectorImpl);
export default TimeRangeSelector;
