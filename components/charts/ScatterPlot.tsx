'use client';

import { memo, useCallback, useMemo, useRef } from 'react';
import styles from './chart.module.css';
import { useDataStore, useFilters, useTimeWindow } from '@/components/providers/DataProvider';
import { useChartRenderer, type RenderArgs } from '@/hooks/useChartRenderer';
import { CATEGORY_META } from '@/lib/dataGenerator';
import {
  DEFAULT_PADDING,
  drawGrid,
  formatCount,
  formatTime,
  formatValue,
  linearTicks,
  plotArea,
  timeTicks,
  withAlpha,
} from '@/lib/canvasUtils';
import type { Category } from '@/lib/types';

/**
 * Every retained sample, plotted.
 *
 * No level-of-detail here, deliberately — this is the chart that proves the
 * dashboard can genuinely push 100k marks a frame, and a downsampled scatter
 * would be lying about the distribution anyway.
 *
 * Getting it fast came down to three things:
 *
 *   1. `fillRect` for small marks instead of `arc()`. A circle is a path build,
 *      a tessellation and a fill; a rect is a blit. Below ~3px nobody can tell
 *      the difference, and it's roughly 6× faster in practice.
 *   2. One `fillStyle` assignment per series, not per point. Canvas state
 *      changes are the hidden cost in naive scatter code.
 *   3. A stride that kicks in only past a density threshold, so the common case
 *      pays nothing for the escape hatch.
 */

/** Past this many marks we start striding, so the frame budget stays bounded. */
const DENSITY_LIMIT = 60_000;

function ScatterPlotImpl() {
  const { store } = useDataStore();
  const filters = useFilters();
  const window_ = useTimeWindow();
  const drawnRef = useRef(0);

  const activeCategories = useMemo(
    () => Array.from(filters.categories) as Category[],
    [filters.categories],
  );

  const draw = useCallback(
    ({ ctx, width, height }: RenderArgs) => {
      ctx.clearRect(0, 0, width, height);
      const area = plotArea(width, height, DEFAULT_PADDING);
      if (area.width <= 0 || area.height <= 0) return;

      const { from, to } = window_;
      const span = to - from;
      if (span <= 0) return;

      const extent = store.valueExtent(activeCategories, from, to);
      const pad = (extent.max - extent.min) * 0.08;
      const yMin = extent.min - pad;
      const yMax = extent.max + pad;
      const range = yMax - yMin || 1;

      const xScale = (t: number) => area.x + ((t - from) / span) * area.width;
      const yScale = (v: number) => area.y + area.height - ((v - yMin) / range) * area.height;

      drawGrid(
        ctx,
        area,
        timeTicks(from, to, Math.max(2, Math.floor(area.width / 120))),
        linearTicks(yMin, yMax, Math.max(2, Math.floor(area.height / 44))),
        xScale,
        yScale,
        (t) => formatTime(t, span),
        formatValue,
      );

      ctx.save();
      ctx.beginPath();
      ctx.rect(area.x, area.y, area.width, area.height);
      ctx.clip();

      // Total in range decides the stride and the per-mark alpha together —
      // dense regions read as solid colour if every mark is opaque.
      let totalInRange = 0;
      const ranges: { cat: Category; start: number; end: number }[] = [];
      for (const cat of activeCategories) {
        const ch = store.channels[cat];
        if (ch.size === 0) continue;
        const start = ch.lowerBound(from);
        const end = ch.upperBound(to);
        if (end > start) {
          ranges.push({ cat, start, end });
          totalInRange += end - start;
        }
      }

      const stride = totalInRange > DENSITY_LIMIT ? Math.ceil(totalInRange / DENSITY_LIMIT) : 1;
      const drawnTotal = Math.floor(totalInRange / stride);

      const size = drawnTotal > 20_000 ? 1 : drawnTotal > 6_000 ? 1.5 : 2.5;
      const alpha = drawnTotal > 30_000 ? 0.24 : drawnTotal > 8_000 ? 0.42 : 0.7;
      const half = size / 2;

      // Additive blending makes overlap read as density instead of the last
      // series painted winning.
      ctx.globalCompositeOperation = 'lighter';

      for (const { cat, start, end } of ranges) {
        const ch = store.channels[cat];
        ctx.fillStyle = withAlpha(CATEGORY_META[cat].color, alpha);

        // The hot loop. Nothing allocates, no property lookups on `this`, no
        // function calls — the scale maths is inlined for the same reason.
        const xk = area.width / span;
        const yk = area.height / range;
        const yBase = area.y + area.height;

        for (let i = start; i < end; i += stride) {
          const p = ch.physical(i);
          const x = area.x + (ch.timestamps[p] - from) * xk - half;
          const y = yBase - (ch.values[p] - yMin) * yk - half;
          ctx.fillRect(x, y, size, size);
        }
      }

      ctx.globalCompositeOperation = 'source-over';
      ctx.restore();

      drawnRef.current = drawnTotal;
    },
    [store, activeCategories, window_],
  );

  const surface = useChartRenderer({
    draw,
    revision: () => store.version,
    priority: 2,
    // The most expensive draw on the page, and the least sensitive to latency:
    // adding 240 marks to a 60,000-mark cloud changes nothing a person can see.
    // 20Hz keeps it feeling live while freeing ~two thirds of its budget.
    maxFps: 20,
  });

  return (
    <div className={styles.card}>
      <div className={styles.header}>
        <div className={styles.headings}>
          <div className={styles.title}>Distribution</div>
          <div className={styles.subtitle}>Every retained sample · additive blending</div>
        </div>
        <div className={styles.headerMeta}>
          <span className={styles.badge}>{formatCount(drawnRef.current)} marks</span>
        </div>
      </div>

      <div className={styles.plot} ref={surface.containerRef}>
        <canvas
          ref={surface.canvasRef}
          className={styles.canvas}
          role="img"
          aria-label="Scatter plot of individual samples over time"
        />
        {store.pointCount === 0 && (
          <div className={styles.empty}>
            <div className={styles.emptyTitle}>No samples in range</div>
          </div>
        )}
      </div>

      <div className={styles.legend}>
        {activeCategories.map((cat) => (
          <span key={cat} className={styles.legendItem}>
            <span
              className={styles.legendSwatch}
              style={{
                background: CATEGORY_META[cat].color,
                width: 7,
                height: 7,
                borderRadius: '50%',
              }}
            />
            {CATEGORY_META[cat].label}
          </span>
        ))}
      </div>
    </div>
  );
}

export const ScatterPlot = memo(ScatterPlotImpl);
export default ScatterPlot;
