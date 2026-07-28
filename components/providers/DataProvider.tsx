'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
  type ReactNode,
} from 'react';
import { DataStore } from '@/lib/seriesBuffer';
import { useDataStream, type StreamStats } from '@/hooks/useDataStream';
import {
  CATEGORIES,
  forEachSnapshotPoint,
  type AggregationWindow,
  type Category,
  type DashboardFilters,
  type DatasetSnapshot,
  type StreamSettings,
  type TimeRangePreset,
} from '@/lib/types';

/**
 * Four contexts instead of one.
 *
 * This looks like over-engineering until you remember that React re-renders
 * *every* consumer of a context when its value changes. A single
 * `{ store, filters, settings, stats }` object would mean the 1Hz stats tick
 * re-renders the filter panel, the charts, and the table — forever. Splitting
 * by change frequency means each consumer only wakes for the slice it reads.
 *
 *   store    — created once, never changes
 *   actions  — stable callbacks, never changes
 *   filters  — changes on user interaction only
 *   stream   — changes ~1Hz (stats) and on load-control changes
 */

interface StoreValue {
  store: DataStore;
  seed: number;
}

interface ActionsValue {
  toggleCategory: (c: Category) => void;
  setCategories: (c: Category[]) => void;
  setTimeRange: (r: TimeRangePreset) => void;
  setAggregation: (a: AggregationWindow) => void;
  setValueBounds: (min: number, max: number) => void;
  setSearch: (s: string) => void;
  resetFilters: () => void;
  setRunning: (running: boolean) => void;
  setCapacity: (capacity: number) => void;
  /** Resize and immediately fill with plausible history. */
  setCapacityAndFill: (capacity: number) => void;
  setIntervalMs: (ms: number) => void;
  setBatchSize: (n: number) => void;
  toggleStressMode: () => void;
  clearData: () => void;
}

interface StreamValue {
  settings: StreamSettings;
  stats: StreamStats;
  /** True while a filter change is being applied off the urgent path. */
  isPending: boolean;
  /** True while the buffer is being filled with backfilled history. */
  isBackfilling: boolean;
}

const StoreContext = createContext<StoreValue | null>(null);
const FiltersContext = createContext<DashboardFilters | null>(null);
const ActionsContext = createContext<ActionsValue | null>(null);
const StreamContext = createContext<StreamValue | null>(null);

/**
 * Per channel. × 8 channels = 10,000 points, which is the brief's baseline and
 * exactly what the server-rendered seed fills. The load presets take it to 50k,
 * 100k and 250k, each filling immediately via backfill.
 */
const DEFAULT_CAPACITY = 1_250;

const DEFAULT_FILTERS: DashboardFilters = {
  categories: new Set<Category>(['cpu', 'memory', 'network', 'latency']),
  timeRange: '5m',
  aggregation: 'none',
  valueMin: Number.NEGATIVE_INFINITY,
  valueMax: Number.POSITIVE_INFINITY,
  search: '',
};

export interface DataProviderProps {
  initialData: DatasetSnapshot;
  children: ReactNode;
}

export function DataProvider({ initialData, children }: DataProviderProps) {
  const [isPending, startTransition] = useTransition();

  // The store must survive re-renders but must not be built during render
  // (StrictMode would run the constructor twice). A lazy ref is the honest
  // version of `useMemo(..., [])`, which React explicitly does not guarantee.
  const storeRef = useRef<DataStore | null>(null);
  if (storeRef.current === null) {
    storeRef.current = new DataStore(DEFAULT_CAPACITY);
  }
  const store = storeRef.current;

  const hydratedRef = useRef(false);
  const [settings, setSettings] = useState<StreamSettings>({
    capacity: DEFAULT_CAPACITY,
    intervalMs: 100,
    batchSize: CATEGORIES.length,
    running: true,
    stressMode: false,
  });
  const [filters, setFilters] = useState<DashboardFilters>(DEFAULT_FILTERS);

  /**
   * Seed the client buffers from the server-rendered payload. Runs in an effect
   * rather than during render so it never fights hydration, and guards against
   * StrictMode's double-invoke duplicating every point.
   *
   * The timestamps get rebased onto the client clock on the way in. The page is
   * ISR'd with a 30s window, so a cached response can be up to half a minute
   * old — and since the live stream starts at the *client's* `Date.now()`, the
   * un-shifted seed data would leave a visible dead zone between the last
   * server point and the first live one. Shifting by the age of the payload
   * closes the seam. It also corrects for client clock skew, which is a real
   * problem on machines whose time is a few seconds out.
   */
  useEffect(() => {
    if (hydratedRef.current) return;
    hydratedRef.current = true;
    performance.mark('data-hydrate-start');

    const now = Date.now();
    const offset = now - initialData.generatedAt;

    forEachSnapshotPoint(initialData, (category, timestamp, value) => {
      store.push(category, timestamp + offset, value);
    });
    store.commit(now);
    try {
      performance.measure('data-hydrate', 'data-hydrate-start');
    } catch {
      /* ignore */
    }
    performance.clearMarks('data-hydrate-start');
    performance.clearMeasures('data-hydrate');
  }, [initialData, store]);

  useEffect(() => () => store.dispose(), [store]);

  // The initial payload ends "now"; continue the walk from where it stopped so
  // there's no step change at the seam.
  const startTick = useMemo(
    () => Math.ceil(initialData.values.length / CATEGORIES.length),
    [initialData.values.length],
  );

  const stream = useDataStream({
    store,
    settings,
    seed: initialData.seed,
    startTick,
  });

  // ---- Actions --------------------------------------------------------------
  // Every one of these is stable for the life of the provider, so the actions
  // context never invalidates and memoised children never re-render because of it.

  const toggleCategory = useCallback((c: Category) => {
    setFilters((prev) => {
      const next = new Set(prev.categories);
      if (next.has(c)) {
        // Refuse to empty the selection — an empty chart reads as a bug.
        if (next.size === 1) return prev;
        next.delete(c);
      } else {
        next.add(c);
      }
      return { ...prev, categories: next };
    });
  }, []);

  const setCategories = useCallback((list: Category[]) => {
    setFilters((prev) => ({ ...prev, categories: new Set(list.length ? list : ['cpu']) }));
  }, []);

  // Range and aggregation changes can trigger a full re-bucket of 100k points.
  // Marking them as transitions keeps the click feedback instant and lets React
  // interrupt the work if another click lands.
  const setTimeRange = useCallback(
    (r: TimeRangePreset) => {
      startTransition(() => setFilters((prev) => ({ ...prev, timeRange: r })));
    },
    [startTransition],
  );

  const setAggregation = useCallback(
    (a: AggregationWindow) => {
      startTransition(() => setFilters((prev) => ({ ...prev, aggregation: a })));
    },
    [startTransition],
  );

  const setValueBounds = useCallback((min: number, max: number) => {
    setFilters((prev) => ({ ...prev, valueMin: min, valueMax: max }));
  }, []);

  const setSearch = useCallback((s: string) => {
    setFilters((prev) => ({ ...prev, search: s }));
  }, []);

  const resetFilters = useCallback(() => {
    setFilters({ ...DEFAULT_FILTERS, categories: new Set(DEFAULT_FILTERS.categories) });
  }, []);

  const setRunning = useCallback((running: boolean) => {
    setSettings((prev) => ({ ...prev, running }));
  }, []);

  const setCapacity = useCallback(
    (capacity: number) => {
      // Reallocating eight typed arrays is a few ms of copying; keep it off the
      // urgent path so the slider itself stays smooth.
      startTransition(() => {
        store.resize(capacity);
        setSettings((prev) => ({ ...prev, capacity }));
      });
    },
    [store, startTransition],
  );

  /**
   * Resize *and* fill.
   *
   * The preset buttons use this rather than a bare resize, because a buffer
   * sized for 100k points that contains 10k is not a demonstration of anything.
   */
  const setCapacityAndFill = useCallback(
    (capacity: number) => {
      store.resize(capacity);
      setSettings((prev) => ({ ...prev, capacity }));
      stream.backfill(capacity);
    },
    [store, stream],
  );

  const setIntervalMs = useCallback((ms: number) => {
    setSettings((prev) => ({ ...prev, intervalMs: ms }));
  }, []);

  const setBatchSize = useCallback((n: number) => {
    setSettings((prev) => ({ ...prev, batchSize: n }));
  }, []);

  const toggleStressMode = useCallback(() => {
    setSettings((prev) =>
      prev.stressMode
        ? { ...prev, stressMode: false, intervalMs: 100, batchSize: CATEGORIES.length }
        : // 16ms × 240 points ≈ 15k points/sec, which is well past anything the
          // brief asks for and makes frame drops obvious if they exist.
          { ...prev, stressMode: true, intervalMs: 16, batchSize: 240 },
    );
  }, []);

  const clearData = useCallback(() => {
    store.clear();
  }, [store]);

  const actions = useMemo<ActionsValue>(
    () => ({
      toggleCategory,
      setCategories,
      setTimeRange,
      setAggregation,
      setValueBounds,
      setSearch,
      resetFilters,
      setRunning,
      setCapacity,
      setCapacityAndFill,
      setIntervalMs,
      setBatchSize,
      toggleStressMode,
      clearData,
    }),
    [
      toggleCategory,
      setCategories,
      setTimeRange,
      setAggregation,
      setValueBounds,
      setSearch,
      resetFilters,
      setRunning,
      setCapacity,
      setCapacityAndFill,
      setIntervalMs,
      setBatchSize,
      toggleStressMode,
      clearData,
    ],
  );

  const storeValue = useMemo<StoreValue>(
    () => ({ store, seed: initialData.seed }),
    [store, initialData.seed],
  );

  const streamValue = useMemo<StreamValue>(
    () => ({ settings, stats: stream, isPending, isBackfilling: stream.isBackfilling }),
    [settings, stream, isPending],
  );

  return (
    <StoreContext.Provider value={storeValue}>
      <ActionsContext.Provider value={actions}>
        <FiltersContext.Provider value={filters}>
          <StreamContext.Provider value={streamValue}>{children}</StreamContext.Provider>
        </FiltersContext.Provider>
      </ActionsContext.Provider>
    </StoreContext.Provider>
  );
}

function required<T>(value: T | null, name: string): T {
  if (value === null) throw new Error(`${name} must be used inside <DataProvider>`);
  return value;
}

export function useDataStore(): StoreValue {
  return required(useContext(StoreContext), 'useDataStore');
}

export function useFilters(): DashboardFilters {
  return required(useContext(FiltersContext), 'useFilters');
}

export function useDashboardActions(): ActionsValue {
  return required(useContext(ActionsContext), 'useDashboardActions');
}

export function useStream(): StreamValue {
  return required(useContext(StreamContext), 'useStream');
}

/**
 * Opt-in subscription for components that genuinely need to re-render as data
 * lands (the table, the summary tiles). Throttled inside the store to ~4Hz —
 * charts must never call this.
 */
export function useStoreRevision(): number {
  const { store } = useDataStore();
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
}

/** Resolves the active time-range preset into a concrete [from, to] window. */
export function useTimeWindow(): { from: number; to: number; span: number } {
  const { store } = useDataStore();
  const filters = useFilters();
  const revision = useStoreRevision();

  return useMemo(() => {
    const extent = store.timeExtent();
    const to = extent.max;
    const rangeMs =
      filters.timeRange === 'all'
        ? extent.max - extent.min
        : { '1m': 60_000, '5m': 300_000, '15m': 900_000, '1h': 3_600_000, '6h': 21_600_000 }[
            filters.timeRange
          ];
    const span = Math.max(1_000, Math.min(rangeMs, extent.max - extent.min || rangeMs));
    return { from: to - span, to, span };
    // `revision` is the dependency that matters here — it's what moves the window forward.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, filters.timeRange, revision]);
}
