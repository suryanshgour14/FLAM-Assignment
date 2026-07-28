'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { clamp, rafThrottle } from '@/lib/performanceUtils';

export interface TimeWindow {
  from: number;
  to: number;
}

export interface HoverState {
  /** CSS pixels relative to the plot element. */
  x: number;
  y: number;
  active: boolean;
}

export interface UseChartInteractionOptions {
  /**
   * Pulls the live, auto-following window on demand.
   *
   * A getter rather than a value: passing the window down as state meant the
   * chart re-rendered every time it advanced, which is four times a second
   * forever. Now the render loop asks for it, and React only gets involved when
   * the user actually interacts.
   */
  liveWindow: () => TimeWindow;
  /** Repaint request — interaction changes pixels without changing data. */
  invalidate: () => void;
  /** Left inset in CSS px, so pointer x maps onto the plot area not the card. */
  padLeft: number;
  padRight: number;
  enabled?: boolean;
}

export interface ChartInteraction {
  /** Resolved window: the user's zoom if they have one, otherwise the live one. */
  current: () => TimeWindow;
  isZoomed: boolean;
  isPanning: boolean;
  hover: HoverState;
  hoverRef: React.RefObject<HoverState>;
  reset: () => void;
  bind: {
    onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
    onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => void;
    onPointerUp: (e: React.PointerEvent<HTMLDivElement>) => void;
    onPointerLeave: () => void;
    onDoubleClick: () => void;
  };
  /** Attach to the plot element. Wheel must be a native non-passive listener. */
  plotRef: React.RefObject<HTMLDivElement | null>;
}

const MIN_SPAN_MS = 500;

/**
 * Zoom and pan for a time axis.
 *
 * Everything the render loop needs lives in refs. React state exists only for
 * things the *DOM* has to reflect — the cursor style, the tooltip position, and
 * whether to show the "reset zoom" button. A wheel event therefore repaints the
 * canvas without re-rendering the component at all.
 *
 * Once the user zooms, the window stops following live data. That's intentional:
 * a chart that yanks itself forward while you're reading a spike is infuriating.
 * Double-click, or the reset button, hands it back to the live feed.
 */
export function useChartInteraction({
  liveWindow,
  invalidate,
  padLeft,
  padRight,
  enabled = true,
}: UseChartInteractionOptions): ChartInteraction {
  const plotRef = useRef<HTMLDivElement | null>(null);
  const [isZoomed, setZoomed] = useState(false);
  const [isPanning, setPanning] = useState(false);
  const [hover, setHover] = useState<HoverState>({ x: 0, y: 0, active: false });

  const overrideRef = useRef<TimeWindow | null>(null);
  const hoverRef = useRef<HoverState>({ x: 0, y: 0, active: false });
  const dragRef = useRef<{ pointerId: number; startX: number; window: TimeWindow } | null>(null);
  const liveRef = useRef(liveWindow);
  liveRef.current = liveWindow;

  /** The window to draw: the user's zoom if they have one, else the live one. */
  const current = useCallback((): TimeWindow => overrideRef.current ?? liveRef.current(), []);

  const reset = useCallback(() => {
    overrideRef.current = null;
    setZoomed(false);
    invalidate();
  }, [invalidate]);

  /** Plot-area width in CSS px, i.e. excluding the axis gutters. */
  const plotWidth = useCallback(() => {
    const el = plotRef.current;
    if (!el) return 1;
    return Math.max(1, el.clientWidth - padLeft - padRight);
  }, [padLeft, padRight]);

  // Wheel has to be registered natively with `passive: false`; React's synthetic
  // wheel handler is passive in modern React, so `preventDefault` there is a
  // no-op and the page scrolls out from under the chart.
  useEffect(() => {
    const el = plotRef.current;
    if (!el || !enabled) return;

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();

      const win = current();
      const span = win.to - win.from;
      const rect = el.getBoundingClientRect();
      const localX = clamp(e.clientX - rect.left - padLeft, 0, plotWidth());
      const anchorRatio = localX / plotWidth();
      const anchorTime = win.from + span * anchorRatio;

      // deltaMode 1 is lines, 2 is pages — normalise or a Firefox wheel click
      // zooms roughly 30× further than a Chrome one.
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      const factor = Math.exp((e.deltaY * unit) / 420);

      const live = liveRef.current();
      const maxSpan = Math.max(live.to - live.from, span);
      const nextSpan = clamp(span * factor, MIN_SPAN_MS, maxSpan * 8);

      // Keep the timestamp under the cursor pinned — zooming toward the pointer
      // is the only behaviour that feels right on a time axis.
      const from = anchorTime - nextSpan * anchorRatio;
      overrideRef.current = { from, to: from + nextSpan };

      setZoomed(true);
      invalidate();
    };

    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [enabled, invalidate, padLeft, plotWidth, current]);

  const publishHover = useMemo(
    () =>
      rafThrottle((x: number, y: number, active: boolean) => {
        setHover({ x, y, active });
      }),
    [],
  );

  useEffect(() => () => publishHover.cancel(), [publishHover]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!enabled || e.button !== 0) return;
      dragRef.current = {
        pointerId: e.pointerId,
        startX: e.clientX,
        // Snapshot at drag start so the pan is relative to a fixed origin —
        // reading the live window mid-drag would compound the offset.
        window: { ...current() },
      };
      // Capture so a fast drag that leaves the element still delivers moves.
      e.currentTarget.setPointerCapture(e.pointerId);
      setPanning(true);
    },
    [enabled, current],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!enabled) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      hoverRef.current = { x, y, active: true };

      const drag = dragRef.current;
      if (drag && drag.pointerId === e.pointerId) {
        const span = drag.window.to - drag.window.from;
        const msPerPx = span / plotWidth();
        const shift = (e.clientX - drag.startX) * msPerPx;
        overrideRef.current = {
          from: drag.window.from - shift,
          to: drag.window.to - shift,
        };
        setZoomed(true);
        invalidate();
        return;
      }

      publishHover(x, y, true);
      invalidate();
    },
    [enabled, invalidate, plotWidth, publishHover],
  );

  const endDrag = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (drag && drag.pointerId === e.pointerId) {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
      dragRef.current = null;
      setPanning(false);
    }
  }, []);

  const onPointerLeave = useCallback(() => {
    hoverRef.current = { x: 0, y: 0, active: false };
    publishHover(0, 0, false);
    invalidate();
  }, [invalidate, publishHover]);

  const bind = useMemo(
    () => ({
      onPointerDown,
      onPointerMove,
      onPointerUp: endDrag,
      onPointerLeave,
      onDoubleClick: reset,
    }),
    [onPointerDown, onPointerMove, endDrag, onPointerLeave, reset],
  );

  return { current, isZoomed, isPanning, hover, hoverRef, reset, bind, plotRef };
}
