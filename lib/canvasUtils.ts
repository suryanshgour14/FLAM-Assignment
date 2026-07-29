/**
 * Low-level canvas helpers. Nothing in here knows about React — that separation
 * is what lets the render loop run without touching the component tree.
 */

export interface Padding {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export const DEFAULT_PADDING: Padding = { top: 16, right: 18, bottom: 30, left: 56 };

export interface PlotArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function plotArea(width: number, height: number, pad: Padding): PlotArea {
  return {
    x: pad.left,
    y: pad.top,
    width: Math.max(0, width - pad.left - pad.right),
    height: Math.max(0, height - pad.top - pad.bottom),
  };
}

/**
 * Resize the backing store to match the device pixel ratio, but only when it
 * actually changed. Assigning to canvas.width clears the whole surface, so doing
 * it unconditionally every frame is a silent 100%-repaint bug.
 *
 * Returns true if the surface was reallocated (caller must redraw everything).
 */
export function syncCanvasSize(
  canvas: HTMLCanvasElement,
  cssWidth: number,
  cssHeight: number,
  dpr: number,
): boolean {
  const w = Math.max(1, Math.round(cssWidth * dpr));
  const h = Math.max(1, Math.round(cssHeight * dpr));
  if (canvas.width === w && canvas.height === h) return false;
  canvas.width = w;
  canvas.height = h;
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${cssHeight}px`;
  return true;
}

/**
 * "Nice" tick steps — 1, 2, 5, 10 × powers of ten. Without this you get axis
 * labels like 37.428 and the chart instantly looks amateur.
 */
export function niceStep(rawStep: number): number {
  if (rawStep <= 0 || !Number.isFinite(rawStep)) return 1;
  const exponent = Math.floor(Math.log10(rawStep));
  const magnitude = Math.pow(10, exponent);
  const residual = rawStep / magnitude;
  let step: number;
  if (residual <= 1) step = 1;
  else if (residual <= 2) step = 2;
  else if (residual <= 5) step = 5;
  else step = 10;
  return step * magnitude;
}

export function linearTicks(min: number, max: number, target: number): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return [min];
  const step = niceStep((max - min) / Math.max(1, target));
  const first = Math.ceil(min / step) * step;
  const ticks: number[] = [];
  // Guard against pathological ranges producing a runaway loop.
  for (let v = first, i = 0; v <= max + step * 1e-9 && i < 64; v += step, i += 1) {
    ticks.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  }
  return ticks;
}

const TIME_STEPS = [
  100, 250, 500, 1_000, 2_000, 5_000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000,
  900_000, 1_800_000, 3_600_000, 7_200_000, 21_600_000, 43_200_000, 86_400_000,
];

/** Time axes want human steps (15s, 5m, 1h), not "nice" decimal ones. */
export function timeTicks(min: number, max: number, target: number): number[] {
  if (max <= min) return [min];
  const raw = (max - min) / Math.max(1, target);
  const step = TIME_STEPS.find((s) => s >= raw) ?? TIME_STEPS[TIME_STEPS.length - 1];
  const first = Math.ceil(min / step) * step;
  const ticks: number[] = [];
  for (let v = first, i = 0; v <= max && i < 64; v += step, i += 1) ticks.push(v);
  return ticks;
}

export function formatTime(ms: number, spanMs: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  if (spanMs < 60_000) {
    return `${pad(d.getMinutes())}:${pad(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0').slice(0, 1)}`;
  }
  if (spanMs < 6 * 3_600_000) return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatValue(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (abs >= 10_000) return `${(v / 1_000).toFixed(1)}k`;
  if (abs >= 100) return v.toFixed(0);
  if (abs >= 1) return v.toFixed(1);
  return v.toFixed(2);
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** #rrggbb → rgba(). Cached because charts ask for the same handful every frame. */
const rgbaCache = new Map<string, string>();

export function withAlpha(hex: string, alpha: number): string {
  const key = `${hex}:${alpha}`;
  const hit = rgbaCache.get(key);
  if (hit) return hit;
  const n = parseInt(hex.slice(1), 16);
  const out = `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
  rgbaCache.set(key, out);
  return out;
}

/** Cool → warm ramp for the heatmap. Perceptually ordered, dark-background safe. */
const HEAT_STOPS = ['#101a2e', '#173a5e', '#1e6f8f', '#2dd4bf', '#a3e635', '#f5a524', '#f87171'];

/**
 * The ramp, precomputed once into a flat lookup table.
 *
 * This used to interpolate on demand and return a fresh `[r, g, b]` array. The
 * heatmap calls it once per cell — 480 columns × 8 rows, twelve times a second
 * — so that was ~46,000 three-element arrays allocated *per second*, every one
 * of them dead before the next frame. Pure garbage-collector fuel for a
 * function whose entire output space is 256 colours.
 *
 * Now it's a 256×3 Uint8Array built at module load, and `heatColor` is three
 * array reads with no allocation at all.
 */
const RAMP_STEPS = 256;
const HEAT_RAMP = buildRamp();

function buildRamp(): Uint8Array {
  const ramp = new Uint8Array(RAMP_STEPS * 3);
  const stops = HEAT_STOPS.map((hex) => {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  });

  for (let i = 0; i < RAMP_STEPS; i += 1) {
    const scaled = (i / (RAMP_STEPS - 1)) * (stops.length - 1);
    const lo = Math.min(stops.length - 2, Math.floor(scaled));
    const t = scaled - lo;
    const a = stops[lo];
    const b = stops[lo + 1];
    ramp[i * 3] = Math.round(a[0] + (b[0] - a[0]) * t);
    ramp[i * 3 + 1] = Math.round(a[1] + (b[1] - a[1]) * t);
    ramp[i * 3 + 2] = Math.round(a[2] + (b[2] - a[2]) * t);
  }
  return ramp;
}

/**
 * Writes the colour for `t` (0–1) into `out` at `offset`. Allocation-free by
 * design — the caller owns the destination.
 */
export function heatColorInto(t: number, out: Uint8ClampedArray | Uint8Array, offset: number): void {
  const clamped = t <= 0 ? 0 : t >= 1 ? 1 : t;
  const i = ((clamped * (RAMP_STEPS - 1)) | 0) * 3;
  out[offset] = HEAT_RAMP[i];
  out[offset + 1] = HEAT_RAMP[i + 1];
  out[offset + 2] = HEAT_RAMP[i + 2];
}

export const CHART_INK = {
  grid: 'rgba(148, 163, 184, 0.10)',
  gridStrong: 'rgba(148, 163, 184, 0.18)',
  axis: 'rgba(148, 163, 184, 0.34)',
  text: 'rgba(148, 163, 184, 0.82)',
  textDim: 'rgba(148, 163, 184, 0.55)',
  crosshair: 'rgba(226, 232, 240, 0.45)',
} as const;

/**
 * Grid + axis labels. Drawn straight to canvas rather than SVG: at 8 charts ×
 * ~20 ticks that's 160 DOM nodes being re-laid-out on every zoom frame, and the
 * style recalc alone was enough to miss frames on the first version of this.
 */
export function drawGrid(
  ctx: CanvasRenderingContext2D,
  area: PlotArea,
  xTicks: number[],
  yTicks: number[],
  xScale: (v: number) => number,
  yScale: (v: number) => number,
  xLabel: (v: number) => string,
  yLabel: (v: number) => string,
): void {
  ctx.save();
  ctx.lineWidth = 1;
  ctx.strokeStyle = CHART_INK.grid;
  ctx.beginPath();
  for (const t of yTicks) {
    const y = Math.round(yScale(t)) + 0.5;
    if (y < area.y - 1 || y > area.y + area.height + 1) continue;
    ctx.moveTo(area.x, y);
    ctx.lineTo(area.x + area.width, y);
  }
  for (const t of xTicks) {
    const x = Math.round(xScale(t)) + 0.5;
    if (x < area.x - 1 || x > area.x + area.width + 1) continue;
    ctx.moveTo(x, area.y);
    ctx.lineTo(x, area.y + area.height);
  }
  ctx.stroke();

  ctx.font = '11px ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace';
  ctx.fillStyle = CHART_INK.textDim;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (const t of yTicks) {
    const y = yScale(t);
    if (y < area.y - 1 || y > area.y + area.height + 1) continue;
    ctx.fillText(yLabel(t), area.x - 8, y);
  }

  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (const t of xTicks) {
    const x = xScale(t);
    if (x < area.x - 1 || x > area.x + area.width + 1) continue;
    ctx.fillText(xLabel(t), x, area.y + area.height + 8);
  }

  ctx.strokeStyle = CHART_INK.axis;
  ctx.beginPath();
  ctx.moveTo(area.x + 0.5, area.y);
  ctx.lineTo(area.x + 0.5, area.y + area.height + 0.5);
  ctx.lineTo(area.x + area.width, area.y + area.height + 0.5);
  ctx.stroke();
  ctx.restore();
}

export function clearCanvas(ctx: CanvasRenderingContext2D, width: number, height: number): void {
  ctx.clearRect(0, 0, width, height);
}

/**
 * Contexts are requested with alpha:false where the chart paints its own
 * background — the compositor can then skip blending the layer, which is worth
 * a couple of ms per frame on a big surface.
 */
export function get2dContext(
  canvas: HTMLCanvasElement,
  opaque = false,
): CanvasRenderingContext2D | null {
  return canvas.getContext('2d', {
    alpha: !opaque,
    desynchronized: true,
  }) as CanvasRenderingContext2D | null;
}
