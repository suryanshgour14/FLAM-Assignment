'use client';

import { memo, type RefObject } from 'react';
import styles from './chart.module.css';
import { useDataStore, useStoreRevision } from '@/components/providers/DataProvider';
import { CATEGORY_META } from '@/lib/dataGenerator';
import { formatCount, formatValue } from '@/lib/canvasUtils';
import type { Category } from '@/lib/types';

/**
 * The small pieces of chart chrome that genuinely do need React.
 *
 * Once the charts stopped subscribing to the store (see lib/timeWindow.ts),
 * anything they rendered from live data went stale — the legend's latest value,
 * the "N marks" badge, the empty-state overlay. Rather than put the whole chart
 * back on the 4Hz update path to keep three spans current, each of those is its
 * own subscriber here.
 *
 * That's the trade being made deliberately: a handful of leaf components
 * re-render four times a second, and the expensive parents never do.
 */

/** Shown while the buffer is empty. Subscribes so it disappears when data lands. */
export const EmptyOverlay = memo(function EmptyOverlay({
  title = 'Waiting for data',
  hint,
}: {
  title?: string;
  hint?: string;
}) {
  const { store } = useDataStore();
  useStoreRevision();

  if (store.pointCount > 0) return null;

  return (
    <div className={styles.empty}>
      <div className={styles.emptyTitle}>{title}</div>
      {hint && <div>{hint}</div>}
    </div>
  );
});

/**
 * A badge whose text is produced by the render loop rather than by React.
 *
 * The draw callback writes into a ref; this reads it on the next tick. Slightly
 * unusual, but the alternative is threading a number out of a canvas draw into
 * state 60 times a second, which is exactly what this architecture avoids.
 */
export const LiveBadge = memo(function LiveBadge({
  valueRef,
  suffix,
  accent = false,
}: {
  valueRef: RefObject<number>;
  suffix: string;
  accent?: boolean;
}) {
  useStoreRevision();
  return (
    <span className={`${styles.badge} ${accent ? styles.badgeAccent : ''}`}>
      {formatCount(valueRef.current)} {suffix}
    </span>
  );
});

/** Legend with live values, shared by the line and bar charts. */
export const Legend = memo(function Legend({
  categories,
  shape = 'line',
  showValues = false,
}: {
  categories: Category[];
  shape?: 'line' | 'square' | 'dot';
  showValues?: boolean;
}) {
  const { store } = useDataStore();
  useStoreRevision();

  const swatch = (color: string) => {
    if (shape === 'square') {
      return { background: color, width: 8, height: 8, borderRadius: 2 };
    }
    if (shape === 'dot') {
      return { background: color, width: 7, height: 7, borderRadius: '50%' };
    }
    return { background: color };
  };

  return (
    <div className={styles.legend}>
      {categories.map((cat) => {
        const meta = CATEGORY_META[cat];
        const ch = store.channels[cat];
        return (
          <span key={cat} className={styles.legendItem}>
            <span className={styles.legendSwatch} style={swatch(meta.color)} />
            {meta.label}
            {showValues && ch.size > 0 && (
              <span className={styles.legendValue}>
                {formatValue(ch.valueAt(ch.size - 1))}
                {meta.unit}
              </span>
            )}
          </span>
        );
      })}
    </div>
  );
});
