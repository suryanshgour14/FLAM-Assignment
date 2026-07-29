'use client';

import { memo, startTransition, useCallback, useDeferredValue, useState } from 'react';
import styles from './controls.module.css';
import {
  useDashboardActions,
  useDataStore,
  useFilters,
  useStoreRevision,
} from '@/components/providers/DataProvider';
import { CATEGORY_LIST } from '@/lib/dataGenerator';
import { formatValue } from '@/lib/canvasUtils';
import type { Category } from '@/lib/types';

/**
 * Channel selection and search.
 *
 * The search box is the clearest example of concurrent rendering earning its
 * keep in this app. Keystrokes update `text` urgently so the input never lags,
 * while `useDeferredValue` lets React re-run the (much heavier) filtered list
 * at a lower priority. Typing quickly through "thr" then produces one settled
 * render instead of three full passes.
 */
function FilterPanelImpl() {
  const filters = useFilters();
  const actions = useDashboardActions();

  const [text, setText] = useState(filters.search);

  /**
   * `useDeferredValue` keeps the input responsive: `text` updates urgently so
   * the caret never lags, and the filtered list below re-runs at lower
   * priority. Typing "thr" quickly settles into one render instead of three.
   */
  const deferredText = useDeferredValue(text);

  /**
   * Shared state is updated from the event handler, *not* from an effect.
   *
   * This was originally `useEffect(() => actions.setSearch(deferredText),
   * [deferredText, actions])`, which is an infinite loop: `setSearch` spreads
   * into a new filters object every time, that new object is a new context
   * value, the new context value re-renders this component, and the deferred-
   * value machinery re-runs the effect. React only warns about it in
   * development — in a production build it span silently at roughly 280 updates
   * per second, and the only visible symptom was a heap that grew forever.
   *
   * Found by diffing heap snapshots: a single fiber's `baseQueue` had 60,000+
   * pending updates chained off it.
   */
  const onSearchChange = useCallback(
    (value: string) => {
      setText(value);
      startTransition(() => actions.setSearch(value));
    },
    [actions],
  );

  const needle = deferredText.trim().toLowerCase();
  const visible = needle
    ? CATEGORY_LIST.filter(
        (c) => c.label.toLowerCase().includes(needle) || c.id.includes(needle),
      )
    : CATEGORY_LIST;

  const allOn = filters.categories.size === CATEGORY_LIST.length;

  return (
    <div className={styles.section}>
      <div className={styles.sectionHead}>
        <span className={styles.label}>Channels</span>
        <button
          type="button"
          className={styles.labelAction}
          onClick={() =>
            actions.setCategories(allOn ? ['cpu'] : CATEGORY_LIST.map((c) => c.id as Category))
          }
        >
          {allOn ? 'Only CPU' : 'Select all'}
        </button>
      </div>

      <div className={styles.searchWrap}>
        <span className={styles.searchIcon} aria-hidden="true">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
            <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.5" />
            <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </span>
        <input
          className={styles.search}
          type="search"
          value={text}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Filter channels…"
          aria-label="Filter channels by name"
          spellCheck={false}
        />
      </div>

      <div className={styles.channels} role="group" aria-label="Visible channels">
        {visible.map((meta) => {
          const on = filters.categories.has(meta.id as Category);
          return (
            <button
              key={meta.id}
              type="button"
              className={`${styles.channel} ${on ? styles.channelOn : ''}`}
              onClick={() => actions.toggleCategory(meta.id as Category)}
              aria-pressed={on}
            >
              <span
                className={styles.dot}
                style={{
                  background: meta.color,
                  boxShadow: on ? `0 0 8px ${meta.color}66` : 'none',
                }}
              />
              <span className={styles.channelName}>{meta.label}</span>
              <LiveValue category={meta.id as Category} unit={meta.unit} />
            </button>
          );
        })}
        {visible.length === 0 && <div className={styles.note}>No channel matches “{text}”.</div>}
      </div>
    </div>
  );
}

/**
 * Reads the newest sample straight out of the ring buffer.
 *
 * Isolated into its own tiny component so the store's ~4Hz notification
 * re-renders eight of these instead of the entire filter panel. The subscription
 * is deliberately the throttled one — a readout that updates ten times a second
 * is unreadable anyway.
 */
const LiveValue = memo(function LiveValue({
  category,
  unit,
}: {
  category: Category;
  unit: string;
}) {
  const { store } = useDataStore();
  useStoreRevision();

  const ch = store.channels[category];
  if (ch.size === 0) return <span className={styles.channelValue}>—</span>;

  return (
    <span className={styles.channelValue}>
      {formatValue(ch.valueAt(ch.size - 1))}
      {unit}
    </span>
  );
});

export const FilterPanel = memo(FilterPanelImpl);
export default FilterPanel;
