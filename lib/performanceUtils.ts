/**
 * Measurement plumbing. Kept framework-free so it can be used from the render
 * loop, from the worker, and from React without three copies.
 */

/**
 * Rolling frame-time window.
 *
 * An average FPS number is close to useless — 59 fps with one 200ms stall reads
 * the same as a genuinely smooth 59. So this keeps the raw frame times and
 * reports p95 and worst alongside the mean, and counts anything over 20ms as a
 * dropped frame (a missed vsync at 60Hz).
 */
export class FrameSampler {
  private readonly samples: Float32Array;
  private cursor = 0;
  private filled = 0;
  private lastTs = 0;
  droppedFrames = 0;

  constructor(private readonly windowSize = 120) {
    this.samples = new Float32Array(windowSize);
  }

  /** Feed it `performance.now()` from inside rAF. Returns the frame delta. */
  sample(now: number): number {
    if (this.lastTs === 0) {
      this.lastTs = now;
      return 0;
    }
    const delta = now - this.lastTs;
    this.lastTs = now;

    this.samples[this.cursor] = delta;
    this.cursor = (this.cursor + 1) % this.windowSize;
    if (this.filled < this.windowSize) this.filled += 1;
    if (delta > 20) this.droppedFrames += 1;

    return delta;
  }

  get fps(): number {
    const mean = this.mean();
    return mean > 0 ? 1000 / mean : 0;
  }

  mean(): number {
    if (this.filled === 0) return 0;
    let sum = 0;
    for (let i = 0; i < this.filled; i += 1) sum += this.samples[i];
    return sum / this.filled;
  }

  worst(): number {
    let max = 0;
    for (let i = 0; i < this.filled; i += 1) {
      if (this.samples[i] > max) max = this.samples[i];
    }
    return max;
  }

  /**
   * Copy-then-sort. `filled` caps at 120, so this is ~120 elements once per
   * second — cheap enough that a fancier streaming quantile isn't worth it.
   */
  percentile(p: number): number {
    if (this.filled === 0) return 0;
    const copy = Array.from(this.samples.subarray(0, this.filled));
    copy.sort((a, b) => a - b);
    const idx = Math.min(copy.length - 1, Math.max(0, Math.round((p / 100) * (copy.length - 1))));
    return copy[idx];
  }

  reset(): void {
    this.cursor = 0;
    this.filled = 0;
    this.lastTs = 0;
    this.droppedFrames = 0;
  }
}

/** Exponential moving average — smooths the render-time readout so it's legible. */
export class Ema {
  value = 0;
  private primed = false;

  constructor(private readonly alpha = 0.12) {}

  push(v: number): number {
    if (!this.primed) {
      this.value = v;
      this.primed = true;
    } else {
      this.value += this.alpha * (v - this.value);
    }
    return this.value;
  }

  reset(): void {
    this.value = 0;
    this.primed = false;
  }
}

interface ChromeMemory {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
}

/**
 * `performance.memory` is Chromium-only and non-standard. Everywhere else we
 * fall back to the size of our own typed arrays, which is honest — it's the
 * number we actually control — and the UI labels it as such.
 */
export function readHeap(): { used: number; limit: number; supported: boolean } {
  if (typeof performance === 'undefined') return { used: 0, limit: 0, supported: false };
  const mem = (performance as Performance & { memory?: ChromeMemory }).memory;
  if (!mem) return { used: 0, limit: 0, supported: false };
  return { used: mem.usedJSHeapSize, limit: mem.jsHeapSizeLimit, supported: true };
}

/**
 * Trailing-edge throttle on a rAF boundary.
 *
 * Wheel and pointermove fire far faster than the display refreshes; coalescing
 * them to one call per frame is the difference between a zoom that feels
 * instant and one that queues up 400ms of stale work.
 */
export function rafThrottle<A extends unknown[]>(fn: (...args: A) => void): ((...args: A) => void) & {
  cancel: () => void;
} {
  let frame: number | null = null;
  let lastArgs: A | null = null;

  const wrapped = (...args: A) => {
    lastArgs = args;
    if (frame !== null) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      if (lastArgs) fn(...lastArgs);
    });
  };

  wrapped.cancel = () => {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    lastArgs = null;
  };

  return wrapped;
}

export function debounce<A extends unknown[]>(
  fn: (...args: A) => void,
  ms: number,
): ((...args: A) => void) & { cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const wrapped = (...args: A) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
  wrapped.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  return wrapped;
}

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

/**
 * Wraps a synchronous block in a User Timing measure so it shows up in the
 * DevTools performance track *and* gets picked up by our PerformanceObserver.
 */
export function measure<T>(name: string, fn: () => T): T {
  if (typeof performance === 'undefined' || !performance.mark) return fn();
  const start = `${name}-start`;
  performance.mark(start);
  try {
    return fn();
  } finally {
    try {
      performance.measure(name, start);
    } catch {
      // A measure can throw if the mark was cleared mid-flight. Not worth caring about.
    }
    performance.clearMarks(start);
    // Left unbounded, the entry buffer is itself a slow memory leak.
    performance.clearMeasures(name);
  }
}

/** Rough frame budget classification, used for the colour of the FPS pill. */
export function fpsGrade(fps: number): 'good' | 'ok' | 'bad' {
  if (fps >= 55) return 'good';
  if (fps >= 30) return 'ok';
  return 'bad';
}
