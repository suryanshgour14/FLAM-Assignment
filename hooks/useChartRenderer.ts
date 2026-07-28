'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { get2dContext, syncCanvasSize } from '@/lib/canvasUtils';
import { scheduler, type FrameInfo } from '@/lib/renderScheduler';

export interface RenderArgs {
  ctx: CanvasRenderingContext2D;
  /** CSS pixels. The context is already scaled, so draw in these units. */
  width: number;
  height: number;
  dpr: number;
  frame: FrameInfo;
  /** True when the surface was just reallocated — everything must be repainted. */
  resized: boolean;
}

export interface UseChartRendererOptions {
  draw: (args: RenderArgs) => void;
  /**
   * Cheap change detector. Return any value that changes when a repaint is
   * needed (usually `store.version`). Returning the same value twice in a row
   * skips the draw entirely — that's what lets six idle charts cost ~0.
   */
  revision: () => unknown;
  /** Paint the canvas opaque; lets the compositor skip alpha blending. */
  opaque?: boolean;
  /** Lower runs first. Keeps the big line chart ahead of the sparklines. */
  priority?: number;
  enabled?: boolean;
}

export interface ChartSurface {
  containerRef: React.RefObject<HTMLDivElement | null>;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  size: { width: number; height: number };
  /** Force a repaint on the next frame (zoom, hover, filter change, …). */
  invalidate: () => void;
  /** Milliseconds the last draw took. Feeds the perf HUD. */
  lastDrawMs: React.RefObject<number>;
}

/**
 * Owns the canvas lifecycle: DPR-correct sizing, a place in the shared frame
 * loop, offscreen skipping, and teardown.
 *
 * Deliberately returns refs rather than pushing pixel dimensions through state
 * on every resize — a drag-resize would otherwise fire dozens of React renders
 * per second. `size` state updates too, but only because axis labels outside
 * the canvas need it, and the ResizeObserver is coalesced to one update per
 * frame.
 */
export function useChartRenderer({
  draw,
  revision,
  opaque = false,
  priority = 0,
  enabled = true,
}: UseChartRendererOptions): ChartSurface {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
  const lastDrawMs = useRef(0);

  const sizeRef = useRef({ width: 0, height: 0 });
  const [size, setSize] = useState({ width: 0, height: 0 });

  const lastRevision = useRef<unknown>(Symbol('initial'));
  const forceRef = useRef(true);
  const visibleRef = useRef(true);
  const dprRef = useRef(1);

  // Stashing the callbacks in refs means changing `draw` (which happens on
  // every parent render, since it closes over props) does not tear down and
  // rebuild the frame subscription.
  const drawRef = useRef(draw);
  const revisionRef = useRef(revision);
  drawRef.current = draw;
  revisionRef.current = revision;

  const invalidate = useCallback(() => {
    forceRef.current = true;
  }, []);

  // Measure before paint so the first frame is already the right size.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    let raf: number | null = null;
    const apply = (w: number, h: number) => {
      if (sizeRef.current.width === w && sizeRef.current.height === h) return;
      sizeRef.current = { width: w, height: h };
      forceRef.current = true;
      if (raf !== null) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        raf = null;
        setSize({ width: w, height: h });
      });
    };

    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const box = entry.contentRect;
      apply(Math.round(box.width), Math.round(box.height));
    });

    ro.observe(el);
    const rect = el.getBoundingClientRect();
    apply(Math.round(rect.width), Math.round(rect.height));

    return () => {
      ro.disconnect();
      if (raf !== null) cancelAnimationFrame(raf);
    };
  }, []);

  // A chart scrolled out of view shouldn't burn frame budget. On a phone, where
  // most of the dashboard is below the fold, this is the single biggest win.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (!entry) return;
        const wasVisible = visibleRef.current;
        visibleRef.current = entry.isIntersecting;
        if (!wasVisible && entry.isIntersecting) forceRef.current = true;
      },
      { rootMargin: '120px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // Moving the window between a Retina and a 1x display changes devicePixelRatio.
  useEffect(() => {
    const sync = () => {
      dprRef.current = Math.min(window.devicePixelRatio || 1, 2);
      forceRef.current = true;
    };
    sync();
    const mq = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);

  useEffect(() => {
    if (!enabled) return;

    const run = (frame: FrameInfo) => {
      const canvas = canvasRef.current;
      if (!canvas || !visibleRef.current) return;

      const { width, height } = sizeRef.current;
      if (width <= 0 || height <= 0) return;

      if (!ctxRef.current || ctxRef.current.canvas !== canvas) {
        ctxRef.current = get2dContext(canvas, opaque);
      }
      const ctx = ctxRef.current;
      if (!ctx) return;

      const resized = syncCanvasSize(canvas, width, height, dprRef.current);

      const rev = revisionRef.current();
      const changed = rev !== lastRevision.current;
      if (!changed && !forceRef.current && !resized) return;

      lastRevision.current = rev;
      forceRef.current = false;

      const t0 = performance.now();
      // Reset then scale, so DPR changes never compound across frames.
      ctx.setTransform(dprRef.current, 0, 0, dprRef.current, 0, 0);
      drawRef.current({ ctx, width, height, dpr: dprRef.current, frame, resized });
      lastDrawMs.current = performance.now() - t0;
    };

    return scheduler.register(run, priority);
  }, [enabled, opaque, priority]);

  // Dropping the context reference on unmount lets the backing surface go.
  useEffect(
    () => () => {
      ctxRef.current = null;
    },
    [],
  );

  return { containerRef, canvasRef, size, invalidate, lastDrawMs };
}
