'use client';

import { memo, useCallback, useMemo, useRef } from 'react';
import styles from './chart.module.css';
import { useDataStore, useFilters, useTimeWindow } from '@/components/providers/DataProvider';
import { useChartRenderer, type RenderArgs } from '@/hooks/useChartRenderer';
import { useChartInteraction } from '@/hooks/useChartInteraction';
import { bucketChannel } from '@/lib/seriesBuffer';
import { CATEGORY_META } from '@/lib/dataGenerator';
import {
  CHART_INK,
  DEFAULT_PADDING,
  drawGrid,
  formatTime,
  formatValue,
  linearTicks,
  plotArea,
  timeTicks,
  withAlpha,
} from '@/lib/canvasUtils';
import type { Category } from '@/lib/types';

/**
 * The main time-series chart.
 *
 * The whole design rests on one observation: a 1200px-wide plot has 1200 usable
 * columns, so drawing more than ~2400 vertices per series is wasted work no
 * matter how many points are in the buffer. Everything below is built around
 * collapsing the visible range into one min/max pair per column.
 *
 * Keeping *both* extremes per column (rather than sampling every Nth point)
 * matters more than it sounds: with plain decimation, a one-sample latency
 * spike appears and disappears as you pan, because whether it survives depends
 * on where the sampling stride happens to land. Min/max makes the envelope
 * stable.
 */

/** Upper bound on columns. Beyond this the extra fidelity is invisible. */
const MAX_BUCKETS = 2048;

/**
 * Scratch arrays, allocated once and reused every frame. Sizing them to the
 * maximum up front means the render loop allocates nothing at all, so there is
 * no per-frame GC pressure to show up as jitter.
 */
function useScratch() {
  return useRef({
    min: new Float32Array(MAX_BUCKETS),
    max: new Float32Array(MAX_BUCKETS),
    avg: new Float32Array(MAX_BUCKETS),
    count: new Uint32Array(MAX_BUCKETS),
  }).current;
}

function LineChartImpl() {
  const { store } = useDataStore();
  const filters = useFilters();
  const base = useTimeWindow();
  const scratch = useScratch();

  const invalidateRef = useRef<() => void>(() => {});
  const invalidate = useCallback(() => invalidateRef.current(), []);

  const interaction = useChartInteraction({
    baseWindow: { from: base.from, to: base.to },
    invalidate,
    padLeft: DEFAULT_PADDING.left,
    padRight: DEFAULT_PADDING.right,
  });

  // Sets are recreated on every filter change; freezing to an array keeps the
  // draw callback's identity stable and gives the inner loop an indexable list.
  const activeCategories = useMemo(
    () => Array.from(filters.categories) as Category[],
    [filters.categories],
  );

  // Latest value per series, for the legend. A ref because it's written during
  // the draw and read during React's render — never the other way round.
  const latestRef = useRef<Record<string, number>>({});

  const draw = useCallback(
    ({ ctx, width, height }: RenderArgs) => {
      ctx.clearRect(0, 0, width, height);
      const area = plotArea(width, height, DEFAULT_PADDING);
      if (area.width <= 0 || area.height <= 0) return;

      const win = interaction.windowRef.current;
      const { from, to } = win;
      const span = to - from;

      // One bucket per physical pixel column, capped.
      const buckets = Math.min(MAX_BUCKETS, Math.max(2, Math.floor(area.width)));

      const extent = store.valueExtent(activeCategories, from, to);
      const headroom = (extent.max - extent.min) * 0.08;
      const yMin = extent.min - headroom;
      const yMax = extent.max + headroom;

      const xScale = (t: number) => area.x + ((t - from) / span) * area.width;
      const yScale = (v: number) => area.y + area.height - ((v - yMin) / (yMax - yMin)) * area.height;

      drawGrid(
        ctx,
        area,
        timeTicks(from, to, Math.max(2, Math.floor(area.width / 110))),
        linearTicks(yMin, yMax, Math.max(2, Math.floor(area.height / 44))),
        xScale,
        yScale,
        (t) => formatTime(t, span),
        formatValue,
      );

      ctx.save();
      // Clip once rather than bounds-checking every vertex — the GPU-side clip
      // is free and it keeps the inner loop branch-light.
      ctx.beginPath();
      ctx.rect(area.x, area.y, area.width, area.height);
      ctx.clip();

      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';

      for (const cat of activeCategories) {
        const channel = store.channels[cat];
        if (channel.size === 0) continue;
        const meta = CATEGORY_META[cat];

        const filled = bucketChannel(
          channel,
          from,
          to,
          buckets,
          scratch.min,
          scratch.max,
          scratch.avg,
          scratch.count,
        );
        if (filled === 0) continue;

        const colWidth = area.width / buckets;

        // --- Envelope (min→max band) -------------------------------------
        // Only worth drawing when a column actually spans a range; at high zoom
        // each column holds one sample and the band would be a flat 0px sliver.
        let spread = 0;
        for (let b = 0; b < buckets; b += 1) {
          if (scratch.count[b] > 0) spread += scratch.max[b] - scratch.min[b];
        }
        const showBand = spread / filled > (yMax - yMin) * 0.004;

        if (showBand) {
          ctx.beginPath();
          let started = false;
          for (let b = 0; b < buckets; b += 1) {
            if (scratch.count[b] === 0) continue;
            const x = area.x + b * colWidth;
            const y = yScale(scratch.max[b]);
            if (!started) {
              ctx.moveTo(x, y);
              started = true;
            } else {
              ctx.lineTo(x, y);
            }
          }
          for (let b = buckets - 1; b >= 0; b -= 1) {
            if (scratch.count[b] === 0) continue;
            ctx.lineTo(area.x + b * colWidth, yScale(scratch.min[b]));
          }
          ctx.closePath();
          ctx.fillStyle = withAlpha(meta.color, 0.1);
          ctx.fill();
        }

        // --- Centre line ---------------------------------------------------
        ctx.beginPath();
        let started = false;
        let lastValue = 0;
        for (let b = 0; b < buckets; b += 1) {
          if (scratch.count[b] === 0) continue;
          const x = area.x + b * colWidth;
          const y = yScale(scratch.avg[b]);
          lastValue = scratch.avg[b];
          if (!started) {
            ctx.moveTo(x, y);
            started = true;
          } else {
            ctx.lineTo(x, y);
          }
        }
        ctx.strokeStyle = meta.color;
        ctx.lineWidth = 1.5;
        ctx.stroke();

        latestRef.current[cat] = lastValue;

        // Live marker on the most recent sample — the small thing that makes a
        // static-looking chart feel alive.
        if (started && channel.newest >= from && channel.newest <= to) {
          const x = xScale(channel.newest);
          const y = yScale(channel.valueAt(channel.size - 1));
          ctx.beginPath();
          ctx.arc(x, y, 3, 0, Math.PI * 2);
          ctx.fillStyle = meta.color;
          ctx.fill();
          ctx.beginPath();
          ctx.arc(x, y, 6, 0, Math.PI * 2);
          ctx.fillStyle = withAlpha(meta.color, 0.18);
          ctx.fill();
        }
      }

      ctx.restore();

      // --- Crosshair -------------------------------------------------------
      const hover = interaction.hoverRef.current;
      if (
        hover.active &&
        hover.x >= area.x &&
        hover.x <= area.x + area.width &&
        hover.y >= area.y &&
        hover.y <= area.y + area.height
      ) {
        ctx.save();
        ctx.strokeStyle = CHART_INK.crosshair;
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(Math.round(hover.x) + 0.5, area.y);
        ctx.lineTo(Math.round(hover.x) + 0.5, area.y + area.height);
        ctx.moveTo(area.x, Math.round(hover.y) + 0.5);
        ctx.lineTo(area.x + area.width, Math.round(hover.y) + 0.5);
        ctx.stroke();
        ctx.restore();

        // Dot on each series at the hovered timestamp.
        const hoverTime = from + ((hover.x - area.x) / area.width) * span;
        ctx.save();
        for (const cat of activeCategories) {
          const ch = store.channels[cat];
          if (ch.size === 0) continue;
          const i = Math.min(ch.size - 1, Math.max(0, ch.lowerBound(hoverTime)));
          const y = yScale(ch.valueAt(i));
          if (y < area.y || y > area.y + area.height) continue;
          ctx.beginPath();
          ctx.arc(hover.x, y, 3.5, 0, Math.PI * 2);
          ctx.fillStyle = CATEGORY_META[cat].color;
          ctx.fill();
          ctx.strokeStyle = 'rgba(8,9,13,0.9)';
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
        ctx.restore();
      }
    },
    [store, activeCategories, scratch, interaction.windowRef, interaction.hoverRef],
  );

  const surface = useChartRenderer({
    draw,
    // `store.version` moves on every ingested batch; `isZoomed` covers the case
    // where the view changed but the data didn't.
    revision: () => store.version,
    priority: 0,
  });
  invalidateRef.current = surface.invalidate;

  const hasData = store.pointCount > 0;
  const win = interaction.window;
  const spanLabel = formatSpan(win.to - win.from);

  return (
    <div className={styles.card}>
      <div className={styles.header}>
        <div className={styles.headings}>
          <div className={styles.title}>Time Series</div>
          <div className={styles.subtitle}>
            Min/max LOD · scroll to zoom, drag to pan, double-click to reset
          </div>
        </div>
        <div className={styles.headerMeta}>
          <span className={`${styles.badge} ${interaction.isZoomed ? styles.badgeAccent : ''}`}>
            {spanLabel}
          </span>
          {interaction.isZoomed && (
            <button className={styles.resetBtn} onClick={interaction.reset} type="button">
              Reset
            </button>
          )}
        </div>
      </div>

      <div
        className={styles.plot}
        ref={(node) => {
          surface.containerRef.current = node;
          interaction.plotRef.current = node;
        }}
      >
        <canvas ref={surface.canvasRef} className={styles.canvas} aria-hidden="true" />
        <div
          className={`${styles.cursorZone} ${interaction.isPanning ? styles.panning : ''}`}
          role="img"
          aria-label={`Time series chart showing ${activeCategories.length} channels over ${spanLabel}`}
          {...interaction.bind}
        />
        {!hasData && (
          <div className={styles.empty}>
            <div className={styles.emptyTitle}>Waiting for data</div>
            <div>The stream is paused or the buffer was cleared.</div>
          </div>
        )}
        {interaction.hover.active && hasData && (
          <HoverTooltip
            x={interaction.hover.x}
            y={interaction.hover.y}
            plotWidth={surface.size.width}
            time={
              win.from +
              ((interaction.hover.x - DEFAULT_PADDING.left) /
                Math.max(1, surface.size.width - DEFAULT_PADDING.left - DEFAULT_PADDING.right)) *
                (win.to - win.from)
            }
            categories={activeCategories}
          />
        )}
        <div className={styles.hint}>scroll · drag · dbl-click</div>
      </div>

      <Legend categories={activeCategories} latest={latestRef} />
    </div>
  );
}

/**
 * Split out and memoised so the tooltip's ~60Hz position updates repaint only
 * this subtree, not the chart shell.
 */
const HoverTooltip = memo(function HoverTooltip({
  x,
  y,
  plotWidth,
  time,
  categories,
}: {
  x: number;
  y: number;
  plotWidth: number;
  time: number;
  categories: Category[];
}) {
  const { store } = useDataStore();

  const rows = categories.map((cat) => {
    const ch = store.channels[cat];
    const meta = CATEGORY_META[cat];
    if (ch.size === 0) return { cat, meta, value: null as number | null };
    const i = Math.min(ch.size - 1, Math.max(0, ch.lowerBound(time)));
    return { cat, meta, value: ch.valueAt(i) };
  });

  // Flip to the left of the cursor near the right edge so the tooltip never
  // hangs off the card.
  const flip = x > plotWidth - 170;

  return (
    <div
      className={styles.tooltip}
      style={{
        left: flip ? undefined : x + 14,
        right: flip ? plotWidth - x + 14 : undefined,
        top: Math.max(6, y - 12),
      }}
    >
      <div className={styles.tooltipTime}>{new Date(time).toLocaleTimeString()}</div>
      {rows.map(({ cat, meta, value }) => (
        <div key={cat} className={styles.tooltipRow}>
          <span className={styles.tooltipDot} style={{ background: meta.color }} />
          <span className={styles.tooltipLabel}>{meta.label}</span>
          <span className={styles.tooltipValue}>
            {value === null ? '—' : formatValue(value)}
            <span className={styles.tooltipUnit}>{meta.unit}</span>
          </span>
        </div>
      ))}
    </div>
  );
});

const Legend = memo(function Legend({
  categories,
  latest,
}: {
  categories: Category[];
  latest: React.RefObject<Record<string, number>>;
}) {
  return (
    <div className={styles.legend}>
      {categories.map((cat) => {
        const meta = CATEGORY_META[cat];
        const value = latest.current[cat];
        return (
          <span key={cat} className={styles.legendItem}>
            <span className={styles.legendSwatch} style={{ background: meta.color }} />
            {meta.label}
            {value !== undefined && (
              <span className={styles.legendValue}>
                {formatValue(value)}
                {meta.unit}
              </span>
            )}
          </span>
        );
      })}
    </div>
  );
});

function formatSpan(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

/**
 * memo() with no comparator is enough here: this component takes no props, so
 * it only re-renders when one of its own hooks fires. The expensive path is the
 * canvas draw, and that never goes through React at all.
 */
export const LineChart = memo(LineChartImpl);
export default LineChart;
