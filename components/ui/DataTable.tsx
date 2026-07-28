'use client';

import { memo, useCallback, useMemo, useState } from 'react';
import styles from './ui.module.css';
import {
  useDataStore,
  useFilters,
  useStoreRevision,
  useTimeWindow,
} from '@/components/providers/DataProvider';
import { useVirtualization } from '@/hooks/useVirtualization';
import { CATEGORY_META } from '@/lib/dataGenerator';
import { formatCount, formatValue } from '@/lib/canvasUtils';
import { AGGREGATION_WINDOWS, CATEGORIES, type Category } from '@/lib/types';

/**
 * Virtualised table over the live buffer.
 *
 * The row model is an index, not an array. Building a 100k-element array of row
 * objects on every store notification would allocate more than the buffer
 * itself; instead we compute a cheap ordering once per notification and read
 * the actual values out of the typed arrays as rows scroll into view.
 *
 * At ~40 visible rows this means the table costs the same at 10k points as it
 * does at 400k.
 */

const ROW_HEIGHT = 30;

interface RowRef {
  cat: Category;
  index: number;
}

function DataTableImpl() {
  const { store } = useDataStore();
  const filters = useFilters();
  const win = useTimeWindow();
  const revision = useStoreRevision();
  const [follow, setFollow] = useState(true);

  const aggregationMs = useMemo(
    () => AGGREGATION_WINDOWS.find((w) => w.id === filters.aggregation)?.ms ?? 0,
    [filters.aggregation],
  );

  /**
   * Newest-first merge across the selected channels.
   *
   * Capped at 5,000 rows: nobody scrolls past that, and building the index
   * itself is the one O(n) step left in this component. The cap is surfaced in
   * the header so the number on screen is never quietly wrong.
   */
  const rows = useMemo<RowRef[]>(() => {
    const cats = CATEGORIES.filter((c) => filters.categories.has(c)) as Category[];
    const out: RowRef[] = [];
    const LIMIT = 5_000;

    // Per-channel cursors walking backwards from the newest sample.
    const cursors = cats.map((cat) => {
      const ch = store.channels[cat];
      return { cat, ch, i: ch.upperBound(win.to) - 1, floor: ch.lowerBound(win.from) };
    });

    while (out.length < LIMIT) {
      let bestIdx = -1;
      let bestTime = Number.NEGATIVE_INFINITY;
      for (let k = 0; k < cursors.length; k += 1) {
        const c = cursors[k];
        if (c.i < c.floor || c.i < 0) continue;
        const t = c.ch.timeAt(c.i);
        if (t > bestTime) {
          bestTime = t;
          bestIdx = k;
        }
      }
      if (bestIdx === -1) break;
      const chosen = cursors[bestIdx];
      const value = chosen.ch.valueAt(chosen.i);
      if (value >= filters.valueMin && value <= filters.valueMax) {
        out.push({ cat: chosen.cat, index: chosen.i });
      }
      chosen.i -= 1;
    }

    return out;
    // `revision` is the trigger; the store object itself is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, filters.categories, filters.valueMin, filters.valueMax, win.from, win.to, revision]);

  const v = useVirtualization({ itemCount: rows.length, itemHeight: ROW_HEIGHT, overscan: 8 });

  // "Follow live" only re-pins when the user is already at the top; otherwise
  // reading a row from two minutes ago would be impossible.
  const handleScroll = useCallback(() => {
    v.onScroll();
    const el = v.scrollRef.current;
    if (el) setFollow(el.scrollTop < ROW_HEIGHT);
  }, [v]);

  const visible = rows.slice(v.startIndex, v.endIndex);

  return (
    <div className={styles.tableCard}>
      <div className={styles.tableHeader}>
        <div className={styles.tableTitle}>Sample Stream</div>
        <div className={styles.tableMeta}>
          {aggregationMs > 0 && (
            <span className={styles.chip}>
              {AGGREGATION_WINDOWS.find((w) => w.id === filters.aggregation)?.label} buckets
            </span>
          )}
          <span className={styles.chip}>
            {formatCount(rows.length)}
            {rows.length >= 5_000 ? '+' : ''} rows
          </span>
          <span className={styles.chip}>{v.endIndex - v.startIndex} rendered</span>
          <button
            type="button"
            className={`${styles.chip} ${styles.chipButton} ${follow ? styles.chipLive : ''}`}
            onClick={() => {
              v.scrollToIndex(0);
              setFollow(true);
            }}
          >
            {follow && <span className={styles.liveDot} />}
            {follow ? 'Live' : 'Jump to live'}
          </button>
        </div>
      </div>

      <div className={styles.columns} aria-hidden="true">
        <span>Time</span>
        <span>Channel</span>
        <span className={styles.colRight}>Value</span>
        <span>Level</span>
      </div>

      <div
        className={styles.scroller}
        ref={v.scrollRef}
        onScroll={handleScroll}
        role="grid"
        aria-rowcount={rows.length}
        aria-label="Live sample stream"
        tabIndex={0}
      >
        {rows.length === 0 ? (
          <div className={styles.tableEmpty}>
            No samples in the selected range. Resume the stream or widen the time range.
          </div>
        ) : (
          <div className={styles.spacer} style={{ height: v.totalHeight }}>
            {/* translate3d rather than `top` — it stays on the compositor and
                skips layout entirely while scrolling. */}
            <div className={styles.rows} style={{ transform: `translate3d(0, ${v.paddingTop}px, 0)` }}>
              {visible.map((r, i) => (
                <Row key={`${r.cat}-${r.index}`} row={r} rowIndex={v.startIndex + i} />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * One row. Memoised on the (channel, index) pair — a row's content is immutable
 * once written, so React can skip it entirely on re-render.
 */
const Row = memo(function Row({ row, rowIndex }: { row: RowRef; rowIndex: number }) {
  const { store } = useDataStore();
  const ch = store.channels[row.cat];
  const meta = CATEGORY_META[row.cat];

  if (row.index < 0 || row.index >= ch.size) return null;

  const t = ch.timeAt(row.index);
  const value = ch.valueAt(row.index);
  const pct = Math.max(0, Math.min(1, (value - meta.min) / (meta.max - meta.min)));

  return (
    <div className={styles.row} style={{ height: ROW_HEIGHT }} role="row" aria-rowindex={rowIndex + 1}>
      <span className={styles.cellTime}>{formatClock(t)}</span>
      <span className={styles.cellChannel}>
        <span className={styles.channelDot} style={{ background: meta.color }} />
        <span>{meta.label}</span>
      </span>
      <span className={styles.cellValue}>
        {formatValue(value)}
        <span className={styles.cellUnit}>{meta.unit}</span>
      </span>
      <span className={styles.cellBar}>
        <span
          className={styles.cellBarFill}
          style={{ width: `${pct * 100}%`, background: meta.color, opacity: 0.75 }}
        />
      </span>
    </div>
  );
});

function formatClock(ms: number): string {
  const d = new Date(ms);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

export const DataTable = memo(DataTableImpl);
export default DataTable;
