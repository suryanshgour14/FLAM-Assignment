/**
 * Reproducible benchmark harness.
 *
 * Drives a real Chrome against a production build and reads the dashboard's own
 * HUD via `data-metric` attributes. Everything in PERFORMANCE.md comes out of
 * this script — if the numbers there look implausible, run it and check.
 *
 * Usage:
 *   npm run build
 *   npm start &            # or: npx next start -p 3100
 *   npm run bench          # defaults to http://localhost:3100
 *
 * The first version of this happily reported a rock-solid 60fps while the page
 * was completely broken and drawing nothing at all, which is the most useful
 * thing it ever taught me. It now refuses to report anything until it has
 * confirmed the dashboard is alive and holding data.
 */

import { chromium } from 'playwright-core';

const BASE = process.argv[2] ?? process.env.BENCH_URL ?? 'http://localhost:3100';
const VIEWPORT = { width: 1600, height: 950 };

/** Milliseconds to sit at a load level before reading. Must exceed the HUD's
 *  120-frame sampling window, or you measure the previous scenario. */
const SETTLE_MS = 13_000;

const PRESETS = [
  { total: 10_000, label: '10k' },
  { total: 50_000, label: '50k' },
  { total: 100_000, label: '100k' },
  { total: 250_000, label: '250k' },
];

async function readMetrics(page) {
  return page.evaluate(() => {
    const out = {};
    for (const el of document.querySelectorAll('[data-metric]')) {
      out[el.getAttribute('data-metric')] = el.getAttribute('data-value');
    }
    return out;
  });
}

/** Frame-time distribution measured independently of the app's own sampler. */
async function sampleFrames(page, count = 240) {
  return page.evaluate(async (n) => {
    const deltas = [];
    let last = performance.now();
    await new Promise((resolve) => {
      let i = 0;
      const tick = (t) => {
        deltas.push(t - last);
        last = t;
        if (++i < n) requestAnimationFrame(tick);
        else resolve();
      };
      requestAnimationFrame(tick);
    });
    deltas.sort((a, b) => a - b);
    const at = (p) => deltas[Math.floor((p / 100) * (deltas.length - 1))];
    return {
      p50: +at(50).toFixed(2),
      p95: +at(95).toFixed(2),
      max: +deltas[deltas.length - 1].toFixed(2),
      over20ms: deltas.filter((d) => d > 20).length,
    };
  }, count);
}

function row(label, m, frames) {
  const fps = Number(m.fps ?? 0).toFixed(0);
  const points = Number(m.points ?? 0);
  const heapMb = (Number(m.heap ?? 0) / 1048576).toFixed(1);
  return (
    `${label.padEnd(22)} ` +
    `fps=${fps.padStart(3)}  ` +
    `p50=${String(frames.p50).padStart(5)}ms  ` +
    `p95=${String(frames.p95).padStart(6)}ms  ` +
    `max=${String(frames.max).padStart(6)}ms  ` +
    `canvas=${Number(m.canvasMs ?? 0).toFixed(2)}ms  ` +
    `held=${String(points).padStart(6)}  ` +
    `heap=${heapMb}MB`
  );
}

const results = [];

const browser = await chromium.launch({
  channel: 'chrome',
  args: [
    // Without this, `performance.memory` is bucketed to 5 MB granularity and a
    // sub-megabyte drift is invisible.
    '--enable-precise-memory-info',
    '--js-flags=--expose-gc',
  ],
});
const page = await browser.newPage({ viewport: VIEWPORT });

const problems = [];
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
page.on('console', (m) => m.type() === 'error' && problems.push(`console: ${m.text()}`));
page.on('response', (r) => r.status() >= 400 && problems.push(`http ${r.status()}: ${r.url()}`));

console.log(`\n▸ ${BASE}/dashboard  (${VIEWPORT.width}×${VIEWPORT.height})\n`);

await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
await page.waitForTimeout(6_000);

// --- Sanity gate ----------------------------------------------------------
const first = await readMetrics(page);
if (!Number(first.points) || !Number(first.fps)) {
  console.error('\n✗ Dashboard is not live. Refusing to report benchmarks.');
  console.error('  metrics:', first);
  console.error('  problems:', problems.length ? problems : 'none');
  await browser.close();
  process.exit(1);
}
console.log(`  worker: ${first.thread === 'worker' ? 'active' : 'FALLBACK to main thread'}\n`);

// --- Capacity sweep at the spec'd 100ms cadence ---------------------------
for (const p of PRESETS) {
  await page.click(`[data-preset="${p.total}"]`);
  await page.waitForTimeout(3_000); // backfill lands across a few frames
  await page.waitForTimeout(SETTLE_MS);
  const frames = await sampleFrames(page);
  const m = await readMetrics(page);
  console.log(row(`${p.label} @ 100ms`, m, frames));
  results.push({ scenario: `${p.label} @ 100ms`, ...m, frames });
}

// --- Stress: 100k points, 240 points every 16ms ---------------------------
await page.click('[data-preset="100000"]');
await page.waitForTimeout(3_000);
await page.click('[data-action="stress"]');
await page.waitForTimeout(SETTLE_MS);
const stressFrames = await sampleFrames(page);
const stressM = await readMetrics(page);
console.log(row('100k STRESS @ 16ms', stressM, stressFrames));
results.push({ scenario: '100k stress @ 16ms', ...stressM, frames: stressFrames });

// --- Interaction latency while stressed -----------------------------------
const box = await page.locator('canvas').first().boundingBox();
const latencies = [];
for (let i = 0; i < 15; i += 1) {
  const ms = await page.evaluate(async ([x, y]) => {
    const t0 = performance.now();
    document
      .elementFromPoint(x, y)
      .dispatchEvent(
        new WheelEvent('wheel', { deltaY: -120, clientX: x, clientY: y, bubbles: true, cancelable: true }),
      );
    // Two frames: one to process, one to confirm the repaint landed.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return performance.now() - t0;
  }, [box.x + box.width / 2, box.y + box.height / 2]);
  latencies.push(ms);
  await page.waitForTimeout(100);
}
latencies.sort((a, b) => a - b);
const zoomMedian = latencies[Math.floor(latencies.length / 2)];
const zoomP95 = latencies[latencies.length - 1];
console.log(
  `\n  zoom latency under stress: median ${zoomMedian.toFixed(1)}ms · worst ${zoomP95.toFixed(1)}ms  (target <100ms)`,
);

await page.click('[data-action="stress"]');

// --- Memory retention -----------------------------------------------------
//
// Comparing two raw `usedJSHeapSize` readings is close to meaningless: you are
// mostly sampling where you happened to land in the GC cycle. Early runs of
// this script reported anywhere from +30 to +340 MB/hour on identical builds,
// purely from that.
//
// A leak is about what survives collection, so force a GC through CDP and
// compare the *post-collection* baselines. That number is stable run to run,
// and it's the one that answers "does this still work after eight hours".
const cdp = await page.context().newCDPSession(page);
await cdp.send('HeapProfiler.enable');

const settledHeap = async () => {
  await cdp.send('HeapProfiler.collectGarbage');
  await page.waitForTimeout(1_200);
  return page.evaluate(() => performance.memory?.usedJSHeapSize ?? 0);
};

await page.waitForTimeout(3_000);
const h0 = await settledHeap();
const DRIFT_MS = Number(process.env.BENCH_DRIFT_MS ?? 180_000);
console.log(`  measuring retained heap over ${DRIFT_MS / 1000}s of live streaming…`);
await page.waitForTimeout(DRIFT_MS);
const h1 = await settledHeap();

const driftMb = (h1 - h0) / 1048576;
const perHour = driftMb * (3_600_000 / DRIFT_MS);
console.log(
  `  retained: ${(h0 / 1048576).toFixed(2)}MB → ${(h1 / 1048576).toFixed(2)}MB  ` +
    `(${driftMb >= 0 ? '+' : ''}${driftMb.toFixed(2)}MB over ${DRIFT_MS / 1000}s ` +
    `≈ ${perHour >= 0 ? '+' : ''}${perHour.toFixed(2)}MB/hr)`,
);

console.log(`\n  errors: ${problems.length ? '\n    ' + problems.join('\n    ') : 'none'}\n`);

if (process.env.BENCH_JSON) {
  console.log(JSON.stringify({ results, latencies, driftMb, perHour }, null, 2));
}

await browser.close();
