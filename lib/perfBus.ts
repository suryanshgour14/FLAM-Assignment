import { Ema } from './performanceUtils';

/**
 * A tiny mailbox for timings produced outside React.
 *
 * This exists because of a mistake worth keeping a note about. The data stream
 * originally reported its own cost with `performance.mark()` /
 * `performance.measure()` and a `PerformanceObserver` picked the entries up.
 * That is the textbook approach and it reads beautifully.
 *
 * It is also four User Timing calls plus an observer callback *per tick*. At
 * the spec'd 100ms cadence that's 40 calls a second and genuinely free. In
 * stress mode the tick runs at 62Hz, and the instrumentation started costing
 * more than the work it was instrumenting — the entry buffer has to be walked
 * and cleared every time, and the observer callback lands as a separate task.
 * Measuring the system was slowing the system down.
 *
 * So the hot paths now write a plain number into a module-level EMA and the HUD
 * reads it once a second. `performance.measure` is still used, but only for
 * coarse one-off events (hydration, backfill) where it shows up usefully in the
 * DevTools performance track and costs nothing at that frequency.
 */

class PerfBus {
  readonly dataProcessing = new Ema(0.15);
  readonly ingest = new Ema(0.15);

  /** Total points written since load. Cheap counter, read by the HUD. */
  pointsWritten = 0;

  recordDataProcessing(ms: number): void {
    this.dataProcessing.push(ms);
  }

  recordIngest(ms: number, points: number): void {
    this.ingest.push(ms);
    this.pointsWritten += points;
  }

  reset(): void {
    this.dataProcessing.reset();
    this.ingest.reset();
  }
}

// Guarded against Next's dev-mode module reloads leaving two buses behind.
const key = '__perfDashBus__';
type G = typeof globalThis & { [key]?: PerfBus };

function get(): PerfBus {
  const g = globalThis as G;
  if (!g[key]) g[key] = new PerfBus();
  return g[key];
}

export const perfBus = get();
