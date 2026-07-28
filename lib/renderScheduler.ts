/**
 * One requestAnimationFrame loop for the whole page.
 *
 * The obvious implementation gives every chart its own rAF. That works, but
 * with six canvases you get six callbacks per frame, six `performance.now()`
 * calls, and — worse — no way to know when the *frame* finished, only when each
 * chart did. Frame budgeting then becomes guesswork.
 *
 * With one driver we get a single pass in a stable order, one timestamp shared
 * by everyone (so charts animating together stay in lockstep), and a real
 * per-frame total to report in the perf HUD.
 */

export interface FrameInfo {
  /** The rAF timestamp — same value for every renderer in this frame. */
  now: number;
  /** Milliseconds since the previous frame. */
  delta: number;
  frame: number;
}

export type RenderTask = (info: FrameInfo) => void;

interface Registration {
  task: RenderTask;
  priority: number;
}

class RenderScheduler {
  private tasks = new Set<Registration>();
  private handle: number | null = null;
  private lastNow = 0;
  private frame = 0;
  private ordered: Registration[] = [];
  private dirtyOrder = true;

  /** Total ms spent inside renderer callbacks in the last frame. */
  lastFrameWorkMs = 0;
  /** Set by the visibility listener; a hidden tab does zero canvas work. */
  private paused = false;

  register(task: RenderTask, priority = 0): () => void {
    const reg: Registration = { task, priority };
    this.tasks.add(reg);
    this.dirtyOrder = true;
    this.start();
    return () => {
      this.tasks.delete(reg);
      this.dirtyOrder = true;
      if (this.tasks.size === 0) this.stop();
    };
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    if (!paused) this.start();
  }

  private start(): void {
    if (this.handle !== null || this.tasks.size === 0) return;
    this.handle = requestAnimationFrame(this.tick);
  }

  private stop(): void {
    if (this.handle !== null) cancelAnimationFrame(this.handle);
    this.handle = null;
    this.lastNow = 0;
  }

  private tick = (now: number): void => {
    this.handle = null;

    if (this.paused) {
      // Still keep the loop alive at rAF cadence — the browser throttles it to
      // ~1Hz for a hidden tab anyway, which is exactly the behaviour we want.
      this.handle = requestAnimationFrame(this.tick);
      return;
    }

    const delta = this.lastNow === 0 ? 16.67 : now - this.lastNow;
    this.lastNow = now;
    this.frame += 1;

    if (this.dirtyOrder) {
      this.ordered = Array.from(this.tasks).sort((a, b) => a.priority - b.priority);
      this.dirtyOrder = false;
    }

    const info: FrameInfo = { now, delta, frame: this.frame };
    const start = performance.now();

    // Snapshot into a local — a renderer is allowed to unregister itself mid-frame.
    const list = this.ordered;
    for (let i = 0; i < list.length; i += 1) {
      try {
        list[i].task(info);
      } catch (err) {
        // One broken chart must not take down every other chart on the page.
        console.error('[renderScheduler] renderer threw', err);
      }
    }

    this.lastFrameWorkMs = performance.now() - start;

    if (this.tasks.size > 0) this.handle = requestAnimationFrame(this.tick);
  };
}

/**
 * Module-scope singleton. Guarded because Next dev-mode module reloads would
 * otherwise leave a second orphaned loop running.
 */
const globalKey = '__perfDashScheduler__';
type GlobalWithScheduler = typeof globalThis & { [globalKey]?: RenderScheduler };

function getScheduler(): RenderScheduler {
  const g = globalThis as GlobalWithScheduler;
  if (!g[globalKey]) g[globalKey] = new RenderScheduler();
  return g[globalKey];
}

export const scheduler = getScheduler();

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    scheduler.setPaused(document.visibilityState === 'hidden');
  });
}
