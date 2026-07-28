'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export interface VirtualRange {
  startIndex: number;
  endIndex: number;
  /** Height of the spacer above the rendered window. */
  paddingTop: number;
  totalHeight: number;
  visibleCount: number;
}

export interface UseVirtualizationOptions {
  itemCount: number;
  itemHeight: number;
  /** Rows rendered beyond each edge, so a fast flick doesn't show blank space. */
  overscan?: number;
}

export interface Virtualizer extends VirtualRange {
  scrollRef: React.RefObject<HTMLDivElement | null>;
  onScroll: () => void;
  scrollToIndex: (index: number) => void;
  scrollToBottom: () => void;
  /** True when the user is parked at the bottom — drives "follow live" mode. */
  isPinnedToBottom: boolean;
}

/**
 * Fixed-height windowing.
 *
 * Fixed height is a real constraint, not laziness: it makes the index maths
 * O(1) and means the scrollbar is correct on the first paint, without a
 * measure-then-reflow pass. The data table has uniform rows, so there's nothing
 * to gain from the variable-height version.
 *
 * Scroll position is kept in a ref and only promoted to state when the visible
 * *window* actually changes. Scrolling a few pixels within the same row set
 * produces zero React renders.
 */
export function useVirtualization({
  itemCount,
  itemHeight,
  overscan = 6,
}: UseVirtualizationOptions): Virtualizer {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [isPinnedToBottom, setPinned] = useState(true);
  const rafRef = useRef<number | null>(null);
  const pendingTop = useRef(0);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const h = entries[0]?.contentRect.height ?? 0;
      setViewportHeight(Math.round(h));
    });
    ro.observe(el);
    setViewportHeight(Math.round(el.getBoundingClientRect().height));
    return () => ro.disconnect();
  }, []);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    pendingTop.current = el.scrollTop;
    if (rafRef.current !== null) return;
    // Coalesce to one update per frame — scroll events out-fire rAF on
    // high-refresh trackpads and each one would otherwise be a render.
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      const top = pendingTop.current;
      setScrollTop(top);
      const distanceFromBottom = el.scrollHeight - top - el.clientHeight;
      setPinned(distanceFromBottom < itemHeight * 1.5);
    });
  }, [itemHeight]);

  useEffect(
    () => () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    },
    [],
  );

  const range = useMemo<VirtualRange>(() => {
    const totalHeight = itemCount * itemHeight;
    if (viewportHeight === 0 || itemCount === 0) {
      return { startIndex: 0, endIndex: 0, paddingTop: 0, totalHeight, visibleCount: 0 };
    }
    const visibleCount = Math.ceil(viewportHeight / itemHeight);
    const rawStart = Math.floor(scrollTop / itemHeight);
    const startIndex = Math.max(0, rawStart - overscan);
    const endIndex = Math.min(itemCount, rawStart + visibleCount + overscan);
    return {
      startIndex,
      endIndex,
      paddingTop: startIndex * itemHeight,
      totalHeight,
      visibleCount,
    };
  }, [itemCount, itemHeight, viewportHeight, scrollTop, overscan]);

  const scrollToIndex = useCallback(
    (index: number) => {
      const el = scrollRef.current;
      if (!el) return;
      el.scrollTop = index * itemHeight;
    },
    [itemHeight],
  );

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, []);

  return { ...range, scrollRef, onScroll, scrollToIndex, scrollToBottom, isPinnedToBottom };
}
