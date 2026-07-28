'use client';

import { memo, useCallback, useMemo, useRef } from 'react';
import styles from './chart.module.css';
import { useDataStore, useFilters, useTimeWindow } from '@/components/providers/DataProvider';
import { useChartRenderer, type RenderArgs } from '@/hooks/useChartRenderer';
import { bucketChannel } from '@/lib/seriesBuffer';
import { CATEGORY_META } from '@/lib/dataGenerator';
import {
  DEFAULT_PADDING,
  drawGrid,
  formatTime,
  formatValue,
  linearTicks,
  plotArea,
  timeTicks,
  withAlpha,
} from '@/lib/canvasUtils';
import { AGGREGATION_WINDOWS, type Category } from '@/lib/types';

/**
 * Grouped bar chart over aggregation windows.
 *
 * This is where the "group by 1min / 5min / 1hour" requirement lives. It reuses
 * the same `bucketChannel` routine as the line chart — the difference is only
 * how many buckets it asks for. Bars need to be wide enough to be readable, so
 * the count is derived from available width instead of pixel columns, and when
 * the user picks an explicit aggregation window the bucket count is derived
 * from that window instead.
 *
 * The min–max whisker on each bar is the honest way to show an average: without
 * it a mean of 40 looks identical whether the underlying samples were all 40 or
 * split between 0 and 80.
 */

const MAX_BARS = 128;

function BarChartImpl() {
  const { store } = useDataStore();
  const filters = useFilters();
  const window_ = useTimeWindow();

  const scratch = useRef({
    min: new Float32Array(MAX_BARS),
    max: new Float32Array(MAX_BARS),
    avg: new Float32Array(MAX_BARS),
    count: new Uint32Array(MAX_BARS),
  }).current;

  const activeCategories = useMemo(
    () => Array.from(filters.categories) as Category[],
    [filters.categories],
  );

  const aggregationMs = useMemo(
    () => AGGREGATION_WINDOWS.find((w) => w.id === filters.aggregation)?.ms ?? 0,
    [filters.aggregation],
  );

  const draw = useCallback(
    ({ ctx, width, height }: RenderArgs) => {
      ctx.clearRect(0, 0, width, height);
      const area = plotArea(width, height, DEFAULT_PADDING);
      if (area.width <= 0 || area.height <= 0) return;

      const from = window_.from;
      const to = window_.to;
      const span = to - from;
      if (span <= 0) return;

      // Every series gets a slot inside each group, so the bar count has to
      // account for how many series are on screen or they turn into hairlines.
      const seriesCount = Math.max(1, activeCategories.length);
      const minGroupWidth = 8 + seriesCount * 4;

      let bars = Math.floor(area.width / minGroupWidth);
      if (aggregationMs > 0) {
        // Honour the user's chosen window, but never draw more bars than fit.
        bars = Math.min(bars, Math.max(1, Math.ceil(span / aggregationMs)));
      }
      bars = Math.max(1, Math.min(MAX_BARS, bars));

      const extent = store.valueExtent(activeCategories, from, to);
      const yMax = extent.max * 1.1;
      const yMin = Math.min(0, extent.min * 1.1);
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
      ctx.rect(area.x, area.y - 4, area.width, area.height + 4);
      ctx.clip();

      const groupWidth = area.width / bars;
      const gutter = Math.min(3, groupWidth * 0.14);
      const slot = (groupWidth - gutter) / seriesCount;
      const barWidth = Math.max(1, slot - Math.min(1.5, slot * 0.18));
      const zeroY = yScale(Math.max(0, yMin));

      for (let s = 0; s < activeCategories.length; s += 1) {
        const cat = activeCategories[s];
        const channel = store.channels[cat];
        if (channel.size === 0) continue;
        const meta = CATEGORY_META[cat];

        const filled = bucketChannel(
          channel,
          from,
          to,
          bars,
          scratch.min,
          scratch.max,
          scratch.avg,
          scratch.count,
        );
        if (filled === 0) continue;

        // One fillStyle assignment per series rather than per bar. Setting a
        // canvas style is a state change; doing it 1000× a frame is measurable.
        ctx.fillStyle = withAlpha(meta.color, 0.78);

        for (let b = 0; b < bars; b += 1) {
          if (scratch.count[b] === 0) continue;
          const x = area.x + b * groupWidth + gutter / 2 + s * slot;
          const y = yScale(scratch.avg[b]);
          const h = zeroY - y;
          if (Math.abs(h) < 0.5) continue;
          ctx.fillRect(x, Math.min(y, zeroY), barWidth, Math.abs(h));
        }

        // Whiskers, batched into a single path for the whole series.
        if (barWidth >= 3) {
          ctx.beginPath();
          for (let b = 0; b < bars; b += 1) {
            if (scratch.count[b] < 2) continue;
            const cx = Math.round(area.x + b * groupWidth + gutter / 2 + s * slot + barWidth / 2);
            const yTop = yScale(scratch.max[b]);
            const yBot = yScale(scratch.min[b]);
            if (yBot - yTop < 1.5) continue;
            ctx.moveTo(cx + 0.5, yTop);
            ctx.lineTo(cx + 0.5, yBot);
          }
          ctx.strokeStyle = withAlpha(meta.color, 0.95);
          ctx.lineWidth = 1;
          ctx.stroke();
        }
      }

      ctx.restore();
    },
    [store, activeCategories, aggregationMs, scratch, window_.from, window_.to],
  );

  const surface = useChartRenderer({
    draw,
    revision: () => store.version,
    priority: 1,
  });

  const activeWindow = AGGREGATION_WINDOWS.find((w) => w.id === filters.aggregation);

  return (
    <div className={styles.card}>
      <div className={styles.header}>
        <div className={styles.headings}>
          <div className={styles.title}>Windowed Aggregate</div>
          <div className={styles.subtitle}>Mean per bucket, whiskers show min–max spread</div>
        </div>
        <div className={styles.headerMeta}>
          <span
            className={`${styles.badge} ${filters.aggregation !== 'none' ? styles.badgeAccent : ''}`}
          >
            {activeWindow?.label ?? 'Auto'}
          </span>
        </div>
      </div>

      <div className={styles.plot} ref={surface.containerRef}>
        <canvas
          ref={surface.canvasRef}
          className={styles.canvas}
          role="img"
          aria-label="Bar chart of aggregated values per time bucket"
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
              style={{ background: CATEGORY_META[cat].color, height: 8, width: 8, borderRadius: 2 }}
            />
            {CATEGORY_META[cat].label}
          </span>
        ))}
      </div>
    </div>
  );
}

export const BarChart = memo(BarChartImpl);
export default BarChart;
