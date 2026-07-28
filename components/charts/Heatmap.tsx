'use client';

import { memo, useCallback, useMemo, useRef } from 'react';
import styles from './chart.module.css';
import { useDataStore, useFilters, useTimeWindow } from '@/components/providers/DataProvider';
import { useChartRenderer, type RenderArgs } from '@/hooks/useChartRenderer';
import { CATEGORY_META } from '@/lib/dataGenerator';
import { CHART_INK, formatTime, heatColor, timeTicks } from '@/lib/canvasUtils';
import { CATEGORIES, type Category } from '@/lib/types';

/**
 * Channel × time intensity map.
 *
 * Drawn by writing pixels into an `ImageData` buffer and blitting once, rather
 * than issuing one `fillRect` per cell. With 8 rows × 240 columns that's ~2000
 * draw calls per frame the naive way; here it's a single `putImageData`.
 *
 * The subtlety is that ImageData is in *device* pixels, so it has to be built
 * at DPR scale and blitted with the transform reset — otherwise it comes out
 * blurry on Retina, or half-size, depending on which half you get wrong.
 *
 * Values are normalised per channel, not globally. Throughput sits around 1450
 * and error rate around 4; on one shared scale every row except throughput
 * would be uniformly black.
 */

const ROW_GAP = 2;
const LABEL_W = 92;
const AXIS_H = 22;

function HeatmapImpl() {
  const { store } = useDataStore();
  const filters = useFilters();
  const window_ = useTimeWindow();

  // The ImageData is reallocated only when the surface size changes, not per
  // frame — allocating a few hundred KB 60 times a second is a GC generator.
  const imageRef = useRef<{ data: ImageData; w: number; h: number } | null>(null);

  const rows = useMemo(() => {
    const selected = filters.categories;
    // Keep the canonical order rather than Set insertion order, so rows don't
    // jump around when a channel is toggled off and back on.
    return CATEGORIES.filter((c) => selected.has(c)) as Category[];
  }, [filters.categories]);

  const draw = useCallback(
    ({ ctx, width, height, dpr }: RenderArgs) => {
      ctx.clearRect(0, 0, width, height);
      if (rows.length === 0 || width <= LABEL_W + 20 || height <= AXIS_H + 20) return;

      const { from, to } = window_;
      const span = to - from;
      if (span <= 0) return;

      const plotX = LABEL_W;
      const plotW = width - LABEL_W - 12;
      const plotH = height - AXIS_H - 8;
      const rowH = plotH / rows.length;
      const cellH = Math.max(1, rowH - ROW_GAP);

      // One column per ~3 CSS px keeps the map legible without turning it into
      // a line chart made of pixels.
      const cols = Math.max(8, Math.min(512, Math.floor(plotW / 3)));

      // --- Build the pixel buffer -----------------------------------------
      const pxW = Math.max(1, Math.round(plotW * dpr));
      const pxH = Math.max(1, Math.round(plotH * dpr));

      let image = imageRef.current;
      if (!image || image.w !== pxW || image.h !== pxH) {
        image = { data: ctx.createImageData(pxW, pxH), w: pxW, h: pxH };
        imageRef.current = image;
      }
      const buf = image.data.data;
      buf.fill(0);

      const colAvg = new Float32Array(cols);
      const colCount = new Uint32Array(cols);

      for (let r = 0; r < rows.length; r += 1) {
        const cat = rows[r];
        const ch = store.channels[cat];
        colAvg.fill(0);
        colCount.fill(0);

        if (ch.size > 0) {
          const start = ch.lowerBound(from);
          const end = ch.upperBound(to);
          for (let i = start; i < end; i += 1) {
            const p = ch.physical(i);
            let c = Math.floor(((ch.timestamps[p] - from) / span) * cols);
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

        const rowTopPx = Math.round(r * rowH * dpr);
        const rowBotPx = Math.min(pxH, Math.round((r * rowH + cellH) * dpr));

        for (let c = 0; c < cols; c += 1) {
          const x0 = Math.round((c / cols) * pxW);
          const x1 = Math.round(((c + 1) / cols) * pxW);
          if (x1 <= x0) continue;

          let cr = 14;
          let cg = 16;
          let cb = 24;
          if (colCount[c] > 0) {
            const t = norm === 0 ? 0.5 : (colAvg[c] - lo) * norm;
            const rgb = heatColor(t);
            cr = rgb[0];
            cg = rgb[1];
            cb = rgb[2];
          }

          for (let y = rowTopPx; y < rowBotPx; y += 1) {
            let idx = (y * pxW + x0) * 4;
            for (let x = x0; x < x1; x += 1) {
              buf[idx] = cr;
              buf[idx + 1] = cg;
              buf[idx + 2] = cb;
              buf[idx + 3] = 255;
              idx += 4;
            }
          }
        }
      }

      // putImageData ignores the current transform, so it needs device-pixel
      // coordinates. Save/restore around it keeps the DPR scale for the text.
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.putImageData(image.data, Math.round(plotX * dpr), 0);
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
    [store, rows, window_],
  );

  const surface = useChartRenderer({
    draw,
    revision: () => store.version,
    priority: 3,
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
        {store.pointCount === 0 && (
          <div className={styles.empty}>
            <div className={styles.emptyTitle}>No samples in range</div>
          </div>
        )}
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
