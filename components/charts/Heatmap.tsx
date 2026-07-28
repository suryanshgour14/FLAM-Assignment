'use client';

import { memo, useCallback, useMemo, useRef } from 'react';
import styles from './chart.module.css';
import { useDataStore, useFilters } from '@/components/providers/DataProvider';
import { EmptyOverlay } from './ChartChrome';
import { useChartRenderer, type RenderArgs } from '@/hooks/useChartRenderer';
import { resolveWindow } from '@/lib/timeWindow';
import { CATEGORY_META } from '@/lib/dataGenerator';
import { CHART_INK, formatTime, heatColor, timeTicks } from '@/lib/canvasUtils';
import { CATEGORIES, type Category } from '@/lib/types';

/**
 * Channel × time intensity map.
 *
 * The first version of this built an `ImageData` at full device resolution and
 * wrote every pixel by hand — 1288 × 446 is ~574,000 pixels, so 2.3 million
 * array writes per frame. It was single-handedly responsible for dropping the
 * dashboard to 24fps under load, and it was pure waste: the map only has
 * `cols × rows` distinct colours in it, and every pixel inside a cell is
 * identical to its neighbours.
 *
 * So now the buffer is built at *cell* resolution — one pixel per cell, ~512×8
 * = 4,096 writes — painted into a small scratch canvas, and scaled up with
 * `drawImage` and smoothing off. The GPU does the magnification for free and
 * the cell edges stay crisp. Same output, ~140× less CPU work.
 *
 * Each row is blitted separately so the gaps between channels survive the
 * scale-up.
 *
 * Values are normalised per channel, not globally. Throughput sits around 1450
 * and error rate around 4; on one shared scale every row except throughput
 * would be uniformly black.
 */

const ROW_GAP = 2;
const LABEL_W = 92;
const AXIS_H = 22;
/** Cell columns. Fixed rather than width-derived, so the scratch canvas is stable. */
const MAX_COLS = 480;

function HeatmapImpl() {
  const { store } = useDataStore();
  const filters = useFilters();

  /**
   * Scratch surface holding the cell-resolution buffer. Created once; at
   * 480 × 8 it is under 16 KB, so it never needs resizing and never allocates
   * inside the frame loop.
   */
  const scratchRef = useRef<{
    canvas: HTMLCanvasElement;
    ctx: CanvasRenderingContext2D;
    image: ImageData;
    colAvg: Float32Array;
    colCount: Uint32Array;
  } | null>(null);

  const rows = useMemo(() => {
    const selected = filters.categories;
    // Keep the canonical order rather than Set insertion order, so rows don't
    // jump around when a channel is toggled off and back on.
    return CATEGORIES.filter((c) => selected.has(c)) as Category[];
  }, [filters.categories]);

  const draw = useCallback(
    ({ ctx, width, height }: RenderArgs) => {
      ctx.clearRect(0, 0, width, height);
      if (rows.length === 0 || width <= LABEL_W + 20 || height <= AXIS_H + 20) return;

      const { from, to, span } = resolveWindow(store, filters.timeRange);
      if (span <= 0) return;

      const plotX = LABEL_W;
      const plotW = width - LABEL_W - 12;
      const plotH = height - AXIS_H - 8;
      const rowH = plotH / rows.length;
      const cellH = Math.max(1, rowH - ROW_GAP);

      // One cell per ~3 CSS px keeps the map legible without turning it into a
      // line chart made of pixels.
      const cols = Math.max(8, Math.min(MAX_COLS, Math.floor(plotW / 3)));

      // --- Lazily build the scratch surface --------------------------------
      let scratch = scratchRef.current;
      if (!scratch) {
        const canvas = document.createElement('canvas');
        canvas.width = MAX_COLS;
        canvas.height = 8; // one row per channel, and there are eight channels
        const sctx = canvas.getContext('2d', { alpha: false, willReadFrequently: false });
        if (!sctx) return;
        scratch = {
          canvas,
          ctx: sctx,
          image: sctx.createImageData(MAX_COLS, 8),
          colAvg: new Float32Array(MAX_COLS),
          colCount: new Uint32Array(MAX_COLS),
        };
        scratchRef.current = scratch;
      }

      const { colAvg, colCount, image } = scratch;
      const buf = image.data;

      // --- Fill the cell buffer, one pixel per cell ------------------------
      for (let r = 0; r < rows.length; r += 1) {
        const ch = store.channels[rows[r]];
        colAvg.fill(0, 0, cols);
        colCount.fill(0, 0, cols);

        if (ch.size > 0) {
          const start = ch.lowerBound(from);
          const end = ch.upperBound(to);
          const k = cols / span;
          for (let i = start; i < end; i += 1) {
            const p = ch.physical(i);
            let c = ((ch.timestamps[p] - from) * k) | 0;
            if (c < 0) c = 0;
            else if (c >= cols) c = cols - 1;
            colAvg[c] += ch.values[p];
            colCount[c] += 1;
          }
        }

        // Per-row normalisation.
        let lo = Number.POSITIVE_INFINITY;
        let hi = Number.NEGATIVE_INFINITY;
        for (let c = 0; c < cols; c += 1) {
          if (colCount[c] === 0) continue;
          const v = colAvg[c] / colCount[c];
          colAvg[c] = v;
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
        const norm = hi > lo ? 1 / (hi - lo) : 0;

        let idx = r * MAX_COLS * 4;
        for (let c = 0; c < cols; c += 1) {
          if (colCount[c] === 0) {
            buf[idx] = 14;
            buf[idx + 1] = 16;
            buf[idx + 2] = 24;
          } else {
            const rgb = heatColor(norm === 0 ? 0.5 : (colAvg[c] - lo) * norm);
            buf[idx] = rgb[0];
            buf[idx + 1] = rgb[1];
            buf[idx + 2] = rgb[2];
          }
          buf[idx + 3] = 255;
          idx += 4;
        }
      }

      scratch.ctx.putImageData(image, 0, 0);

      // --- Scale each row up separately, so the gaps survive ---------------
      ctx.save();
      ctx.imageSmoothingEnabled = false;
      for (let r = 0; r < rows.length; r += 1) {
        ctx.drawImage(
          scratch.canvas,
          0,
          r,
          cols,
          1, // source: one row of cells
          plotX,
          r * rowH,
          plotW,
          cellH, // destination: full width, one channel band
        );
      }
      ctx.restore();

      // --- Labels ----------------------------------------------------------
      ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      for (let r = 0; r < rows.length; r += 1) {
        const meta = CATEGORY_META[rows[r]];
        const cy = r * rowH + cellH / 2;
        ctx.fillStyle = meta.color;
        ctx.fillRect(LABEL_W - 8, cy - 4, 3, 8);
        ctx.fillStyle = CHART_INK.text;
        ctx.fillText(meta.label, LABEL_W - 16, cy);
      }

      ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.fillStyle = CHART_INK.textDim;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      for (const t of timeTicks(from, to, Math.max(2, Math.floor(plotW / 110)))) {
        const x = plotX + ((t - from) / span) * plotW;
        if (x < plotX || x > plotX + plotW) continue;
        ctx.fillText(formatTime(t, span), x, plotH + 7);
      }
    },
    [store, rows, filters.timeRange],
  );

  const surface = useChartRenderer({
    draw,
    revision: () => store.version,
    priority: 3,
    // Each cell already averages hundreds of samples, so one more batch moves
    // it by a fraction of a shade. 12Hz is indistinguishable from 60 here.
    maxFps: 12,
  });

  return (
    <div className={styles.card}>
      <div className={styles.header}>
        <div className={styles.headings}>
          <div className={styles.title}>Density Map</div>
          <div className={styles.subtitle}>Per-channel intensity · single ImageData blit</div>
        </div>
        <div className={styles.headerMeta}>
          <span className={styles.badge}>{rows.length} channels</span>
        </div>
      </div>

      <div className={styles.plot} ref={surface.containerRef}>
        <canvas
          ref={surface.canvasRef}
          className={styles.canvas}
          role="img"
          aria-label="Heatmap of channel intensity over time"
        />
        <EmptyOverlay title="No samples in range" />
      </div>

      <div className={styles.scale}>
        <span>low</span>
        <span className={styles.scaleBar} />
        <span>high</span>
      </div>
    </div>
  );
}

export const Heatmap = memo(HeatmapImpl);
export default Heatmap;
