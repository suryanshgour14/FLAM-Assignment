import type { DataStore } from './seriesBuffer';
import type { TimeRangePreset } from './types';

export interface ResolvedWindow {
  from: number;
  to: number;
  span: number;
}

const PRESET_MS: Record<Exclude<TimeRangePreset, 'all'>, number> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
  '6h': 21_600_000,
};

/**
 * Resolve a range preset against whatever the buffer currently holds.
 *
 * Deliberately a plain function rather than a hook.
 *
 * The charts used to get this from a `useTimeWindow()` hook that subscribed to
 * the store, which meant all four of them re-rendered four times a second for
 * no reason other than to recompute two numbers. A CPU profile under load put
 * React at ~30% of main-thread time, and this was most of it — reconciliation
 * work whose entire output was a pair of timestamps that the draw callback
 * could have computed for itself in a microsecond.
 *
 * So now the render loop calls this directly. The charts re-render only when a
 * filter actually changes, and the window advances every frame for free.
 */
export function resolveWindow(store: DataStore, preset: TimeRangePreset): ResolvedWindow {
  const extent = store.timeExtent();
  const held = extent.max - extent.min;
  const requested = preset === 'all' ? held : PRESET_MS[preset];
  // Never ask for more history than exists, and never collapse to nothing.
  const span = Math.max(1_000, Math.min(requested, held || requested));
  return { from: extent.max - span, to: extent.max, span };
}
