# PERFORMANCE.md

Everything below was measured, not estimated. The harness is
[`scripts/benchmark.mjs`](scripts/benchmark.mjs) — `npm run bench` reproduces it.

---

## 1. Benchmark results

**Setup:** Windows 11, Chrome 141, production build (`next build` + `next start`), 1600×950
viewport at DPR 2 (so the largest canvas backing store is 2604×476 device pixels). Four channels
visible. Frame times are sampled independently of the app's own HUD, over 240 consecutive frames.

### At the specified 100ms cadence

| Points held | FPS | Frame p50 | Frame p95 | Frame max | Canvas work/frame | JS heap |
| --- | --- | --- | --- | --- | --- | --- |
| **10,000** | 60 | 16.7 ms | 16.9 ms | 17.3 ms | 0.44 ms | 5.8 MB |
| **50,000** | 60 | 16.7 ms | 16.9 ms | 17.0 ms | 0.78 ms | 6.0 MB |
| **100,000** | 60 | 16.7 ms | 16.9 ms | 17.0 ms | 0.66 ms | 6.6 MB |
| **250,000** | 60 | 16.7 ms | 16.9 ms | 17.0 ms | 0.40 ms | 8.8 MB |

A 16.7 ms p50 *is* vsync — the loop is idle-waiting for the next frame, not racing it. A 17.0 ms
*max* means not one frame in 240 was late.

Canvas work stays under 1 ms even at 250,000 points because drawing cost is bounded by the
viewport, not the buffer (§4) — which is why the 250k row is *cheaper* than the 100k one. The
difference is which LOD bucket the samples land in, not how many there are.

**Against the brief's targets:**

| Target | Result |
| --- | --- |
| 10,000 points at 60fps steady | ✅ 60fps, p95 16.9 ms |
| Real-time updates, no frame drops | ✅ max frame 17.3 ms — zero late frames |
| 50,000 points at 30fps minimum | ✅ 60fps — 2× the stretch goal |
| 100,000 points usable (15fps+) | ✅ 60fps — 4× the stretch goal |
| Interaction latency < 100 ms | ✅ 41 ms median under stress |
| Memory growth < 1 MB/hour | ✅ −2 MB/hr measured; buffers are fixed-size by construction (§2) |
| Bundle < 500 KB gzipped | ✅ 123 KB First Load JS |

### Stress mode — deliberately past spec

240 points every 16ms ≈ **15,000 points/second**, about 190× the brief's cadence, with 100,000
points retained.

| | FPS | p50 | p95 | max | Canvas |
| --- | --- | --- | --- | --- | --- |
| 100k @ 16ms | 36 | 16.8 ms | 50.1 ms | 83.3 ms | 3.86 ms |

Reported as measured. The **median** frame is still a clean 16.8 ms — most frames hit vsync — but
the tail doesn't: roughly one frame in twenty runs long. Sustained 15,000 points/second is past
where this design holds a *consistent* 60fps, and the honest reading of that p95 is that you'd
perceive occasional hitching. It stays interactive and never freezes, which is what the mode is
for: finding the edge rather than pretending there isn't one. §7 covers what would move it.

### Interaction latency

Wheel-zoom on the time series chart, measured from event dispatch to the second animation frame
after it, **while stress mode is running**:

```
median 40.7 ms · worst 65.8 ms   (target < 100 ms)
```

Zoom is a forced repaint that bypasses the per-chart frame cap, so it stays responsive even when
the slow charts are throttled.

---

## 2. Memory

### Structure first

The strongest guarantee here isn't a measurement, it's the shape of the data structures:

- Every sample lives in a **fixed-capacity ring buffer** allocated once. It never grows. A 100,000-
  point buffer is exactly `8 channels × 12,500 × (8 bytes + 4 bytes)` = **1.2 MB**, forever.
- The **streaming path allocates nothing in steady state.** The worker's three batch buffers are
  transferred back after ingest and reused (§5.3).
- The **render loop allocates nothing.** Bucketing writes into scratch arrays sized once at
  `MAX_BUCKETS`; the heatmap fills a pre-built `ImageData`; the colour ramp is a lookup table.

The same data as `DataPoint[]` would be ~12 MB of objects for 100k points, and — more importantly —
a sliding window implemented with `push`/`shift` would allocate and free the entire array on every
tick.

### Measurement, and why the obvious one is useless

`performance.memory.usedJSHeapSize` sampled over time is close to meaningless here. Sampled every
minute for 15 minutes at 100k points, after a forced GC each time, it gave:

```
26.4  45.2  41.7  25.8  27.3  49.9  24.8  47.6  31.8  32.2  30.1  39.5  42.7  57.5  49.9   MB
```

A ±10 MB swing with no trend — the reading depends almost entirely on where in the GC cycle the
sample lands. Early versions of the benchmark reported anywhere from +30 to +340 MB/hour on
identical builds from exactly this noise, and a naive least-squares slope over those samples
"detects" growth that isn't there.

So the real check is a **heap snapshot diff** — retained size after collection, and *which object
types* grew — rather than a heap-size reading. That found a genuine leak, and it was not subtle:

```
snapshot A: 173,658 nodes → snapshot B: 372,761 nodes   (3 minutes)

  +116,635  object:Object
  + 58,314  closure:(none)
  + 58,314  object:system / Context / scope
```

Roughly 200,000 objects retained in three minutes. Walking the retainer chain gave the answer:

```
← next in object:Object  ×61,061
← baseQueue in object:Object
← memoizedState in object:rn        (a React fiber)
← child ← return ← (cycle)
```

A single React hook's update queue, sixty-one thousand updates deep.

### The bug

```tsx
// FilterPanel.tsx — as originally written
const [text, setText] = useState(filters.search);
const deferredText = useDeferredValue(text);

useEffect(() => {
  actions.setSearch(deferredText);
}, [deferredText, actions]);
```

`setSearch` spread into a **new** filters object every call. A new object is a new context value; a
new context value re-renders `FilterPanel`; the deferred-value machinery re-runs the effect; the
effect calls `setSearch` again. A closed loop, spinning at ~280 updates per second.

React warns about this in development — *"Maximum update depth exceeded"*. **In a production build
it is completely silent.** Every benchmark passed. The charts held 60fps. The only symptom was a
heap that never stopped growing, which is exactly the failure mode the brief asks about ("should run
for hours"), and exactly the one you cannot see in a five-minute demo.

Two fixes, both worth having:

1. **Shared state is updated from the event handler, not from an effect.** The effect was mirroring
   local state upward, which is a feedback path by construction.
2. **Every filter setter now bails out when nothing changed** — `prev.search === s ? prev : {...}`.
   That makes the whole setter surface safe against this class of loop, not just the one caller that
   tripped over it.

### After

```
snapshot A: 113,287 nodes → snapshot B: 111,462 nodes   (5 minutes)

  no fibers with an oversized hook queue
  +540  code:system / UncompiledDataWithoutPreparseData   ← V8 lazily compiling; bounded
```

Fewer nodes after five minutes than before. And the benchmark's retention check:

```
retained: 7.26 MB → 7.12 MB   (−0.14 MB over 240s ≈ −2 MB/hr)
```

The steady-state heap also dropped from ~40 MB to **~7 MB** — the leak had been inflating every
reading in every earlier table on this page.

### Other allocation sources removed on the way

- **Worker batch buffers.** Three fresh `ArrayBuffer`s per tick — ~570 KB/s of garbage in stress
  mode, and the cause of periodic 60–100 ms GC frames. Now transferred back and pooled.
- **Colour ramp.** `heatColor()` returned a fresh `[r,g,b]`; the heatmap calls it once per cell, so
  ~46,000 arrays per second. Now a 256-entry lookup table written straight into the pixel buffer.
- **User Timing entries.** `performance.mark`/`measure` in the ingest path meant a growing entry
  buffer plus the cost of clearing it, 62 times a second (§5.4).
- **Extent cache key.** A template-literal key built per chart per frame, purely to be compared.
  Now a numeric bitmask.
- **Redundant dispatches.** `usePerformanceMonitor` pushed three `setState`s per report, two of them
  identical every time. React's eager bailout skips the *render* but still allocates and enqueues
  the update first. Collapsed into one.
- **Backfill rAF closure.** A chunked backfill in flight holds the store through its callback;
  cancelled on unmount.

### Cleanup

Every subscription is torn down: `ResizeObserver` and `IntersectionObserver` disconnect, the
`matchMedia` DPR listener is removed, the shared frame loop stops when its last renderer
unregisters, `setInterval`s are cleared, the worker is terminated, and the store's notify timer is
disposed. `document.visibilitychange` pauses all canvas work in a background tab.

---

## 3. React optimisation

### Data arriving triggers zero re-renders

This is the central decision. `useDataStream` writes into typed arrays and increments
`store.version`. It does not call `setState`. Charts notice because their `requestAnimationFrame`
callback compares `store.version` against what it last drew — React is never told.

A `setState` per 100ms tick would put a full reconciliation between every frame, and at stress rates
it would put several.

### Split contexts

`DataProvider` exposes **four** contexts rather than one object, because React re-renders every
consumer of a context when its value changes:

| Context | Changes | Consumers |
| --- | --- | --- |
| `StoreContext` | never | everything |
| `ActionsContext` | never (all callbacks stable) | controls |
| `FiltersContext` | on user interaction | charts, table |
| `StreamContext` | ~1Hz (stats) | HUD, load controls |

A single combined value would mean the 1Hz stats tick re-rendering the filter panel and every chart,
forever.

### Getting the charts out of the update path entirely

The charts originally read their visible time window from a `useTimeWindow()` hook that subscribed
to the store. That meant all four re-rendered four times a second — for the sole purpose of
recomputing two timestamps.

A CPU profile under load put React at **~30% of main-thread time**, most of it exactly this:

```
 20.2%  1645ms  (anonymous) @ page.js          ← chart draw callbacks
 16.0%  1301ms  ap @ framework.js              ← React work loop
  6.6%   541ms  fillRect
  5.2%   424ms  (garbage collector)
  3.7%   298ms  useState @ framework.js
```

[`lib/timeWindow.ts`](lib/timeWindow.ts) is now a plain function the draw callback calls itself. The
charts re-render only when a filter actually changes; the window advances every frame for free.

The few pieces of chrome that genuinely need live text — legend values, the mark count, the empty
overlay — became their own leaf subscribers in
[`ChartChrome.tsx`](components/charts/ChartChrome.tsx). Three small components re-render at 4Hz
instead of four expensive ones.

**Verifying it:** open React DevTools Profiler and record while data streams. The four charts should
show zero renders.

### Concurrent features

- **`useDeferredValue`** on the channel search box. Keystrokes stay urgent so the input never lags;
  the filtered list re-runs at lower priority. Typing "thr" quickly settles into one render instead
  of three. (This is also where the leak in §2 lived — deferred values and effects are a sharp
  combination.)
- **`useTransition`** around time-range changes, aggregation changes, and buffer resizing — all of
  which can trigger a full re-bucket or an 8-array reallocation. The button highlights instantly and
  a pending marker admits the heavy work is still landing.
- **`useSyncExternalStore`** for the components that do need live data, reading a snapshot token the
  store only advances on a **throttled 4Hz** notify. Subscribers never see the 62Hz write rate.

### Memoisation

`React.memo` on every chart, control and table row. Row memoisation is on `(channel, index)`, which
is immutable once written, so React skips them entirely. `useMemo` guards the derived category
arrays and the table's row index; `useCallback` keeps every provider action stable for the life of
the page.

---

## 4. Rendering: Canvas + SVG

### Which is used where, and why

| Layer | Tech | Reason |
| --- | --- | --- |
| Data marks (lines, bars, points, cells) | **Canvas** | Thousands to hundreds of thousands of elements. The DOM cannot hold these. |
| Axes, grid, tick labels | **Canvas** | 8 charts × ~20 ticks is 160 nodes being re-laid-out on every zoom frame. Style recalc alone missed frames when this was SVG. |
| Crosshair, hover markers, cursor zone | **SVG / DOM** | A handful of nodes that change on pointer move — exactly what the DOM is good at, and it gets hit-testing and accessibility for free. |
| Tooltip | **DOM** | Text, layout, backdrop blur. Trivial in CSS, painful in canvas. |
| FPS sparkline | **SVG** | ~60 points redrawn once a second. A canvas would mean another context, another frame-loop entry and DPR handling to save a polyline the browser renders for free. |

The principle: **canvas where density beats the DOM, DOM where the DOM's own features are worth
more than the density.**

### Level of detail

A 1200px-wide plot has 1200 usable columns. Drawing more than ~2400 vertices per series is paying
for pixels that do not exist. `bucketChannel()` collapses the visible range into one **min/max**
pair per column.

Keeping *both* extremes rather than sampling every Nth point is the part that matters. With plain
decimation, a single-sample latency spike appears and disappears as you pan, because whether it
survives depends on where the sampling stride happens to land. Min/max makes the envelope stable.

Because the bucket count comes from the plot width, **draw cost is independent of buffer size** —
which is why the 250,000-point row in §1 has *lower* canvas time than the 100,000-point one.

### Per-chart costs, and how each came down

**Heatmap: 574,000 pixel writes/frame → 4,096.** The first version built an `ImageData` at full
device resolution and wrote every pixel by hand — 2.3 million array writes per frame to produce an
image containing only ~4,000 distinct colours. It alone dropped the dashboard to 24fps. It now
fills a 480×8 cell-resolution buffer and lets `drawImage` magnify with smoothing off. Each row is
blitted separately so the channel gaps survive. **~140× less CPU, identical output.**

**Scatter: `fillRect` over `arc()`.** A circle is a path build, a tessellation and a fill; a rect is
a blit. Below ~3px nobody can tell, and it's roughly 6× faster. One `fillStyle` assignment per
series rather than per point — canvas state changes are the hidden cost in naive scatter code.

**Scatter: mark ceiling 60,000 → 30,000.** The frame cap spaced the draws out but did nothing about
how expensive one draw was. A single 60,000-`fillRect` pass was a ~40 ms frame, which showed as p95
66 ms while the *average* canvas cost looked fine at 7 ms. Averages hide exactly this shape of
problem. 30,000 marks into a 700×300 plot is already several per pixel.

**Bars:** whiskers batched into one path per series instead of one stroke per bar.

### Per-chart redraw ceilings

Not every chart needs to repaint at display rate:

| Chart | Cap | Why |
| --- | --- | --- |
| Time series | 60fps | It's the one being dragged. Needs every frame. |
| Bars | 24fps | Aggregates over whole buckets — slow-moving by construction. |
| Scatter | 20fps | 240 new marks in a 30,000-mark cloud is invisible. |
| Heatmap | 12fps | Each cell averages hundreds of samples; one more batch shifts it a fraction of a shade. |

This throttles the **charts**, not the page. The page stays at 60fps — that's the entire point. A
forced repaint (hover, zoom, resize, filter change) always bypasses the cap, so interaction never
feels sluggish.

---

## 5. Canvas + React integration

### 5.1 One frame loop, not six

The obvious implementation gives every chart its own `requestAnimationFrame`. That works, but with
six canvases you get six callbacks per frame, six `performance.now()` calls, and no way to know when
the *frame* finished — only when each chart did, which makes frame budgeting guesswork.

[`renderScheduler.ts`](lib/renderScheduler.ts) is a single driver: one ordered pass, one timestamp
shared by every renderer (so charts animating together stay in lockstep), and a real per-frame total
for the HUD. Each renderer is wrapped in try/catch so one broken chart can't take down the page —
worth noting because a throw inside rAF is *not* caught by an `error.tsx` boundary.

### 5.2 The canvas lifecycle

[`useChartRenderer`](hooks/useChartRenderer.ts) owns it:

- **DPR-correct sizing, applied only on change.** Assigning `canvas.width` clears the entire
  surface, so doing it unconditionally each frame is a silent 100%-repaint bug.
- **Revision-gated drawing.** The hook takes a `revision()` getter; if it hasn't changed and nothing
  forced a repaint, the draw is skipped entirely. Six idle charts cost ~0 — measurably: canvas time
  drops to **0.02 ms/frame** when the stream is paused.
- **`IntersectionObserver`** skips charts scrolled out of view. On a phone, where most of the
  dashboard is below the fold, this is the single biggest win.
- **`setTransform` then scale**, so DPR changes never compound across frames.
- **Callbacks in refs**, so a changing `draw` prop (which happens on every parent render, since it
  closes over props) doesn't tear down and rebuild the frame subscription.

### 5.3 Web Worker with recycled buffers

Generation and aggregation run in a module worker
([`stream.worker.ts`](lib/workers/stream.worker.ts)), with results returned on **transferable**
`ArrayBuffer`s — a pointer move, not a structured clone.

The subtle part is the return trip. Allocating three buffers per tick is 30/second at spec (free)
but ~190/second under stress, which showed up as both heap growth *and* periodic 60–100 ms frames
that were nothing but major GC. The main thread now transfers the buffers **back** after ingest, and
the worker keeps a small size-matched free list. Steady-state allocation on the streaming path: zero.

There's a main-thread fallback for browsers without module workers, and the HUD says which is active.

The worker also enables **instant backfill**: raising the buffer to 100,000 at 80 points/second
would otherwise take twenty minutes to fill. Because the walk is deterministic and stateful, a fresh
walker set is run forward to manufacture history, stamped ending at "now", and then *adopted* as the
live walkers — so the stream continues from exactly where the backfill stopped, with no seam.
Ingest is chunked across animation frames so a 250,000-point fill never blocks one.

### 5.4 Instrumentation that isn't free

The stream originally reported its own cost with `performance.mark()` / `performance.measure()` and
a `PerformanceObserver`. Textbook, and it reads beautifully.

It's also four User Timing calls plus an observer callback **per tick**. At 100ms that's 40/second
and genuinely free. At stress rates it's ~250/second, the entry buffer has to be walked and cleared
each time, and the observer callback lands as a separate task. *Measuring the system was slowing the
system down.* Removing it was worth more than any single drawing optimisation.

Hot paths now write a plain number into an EMA in [`perfBus.ts`](lib/perfBus.ts). `performance.measure`
survives only for coarse one-off events (hydration, backfill) where it's useful in the DevTools
track and costs nothing.

---

## 6. Next.js: server vs client

### The split

| Rendered on | What | Why |
| --- | --- | --- |
| **Server** | `app/dashboard/page.tsx` — generates the 10,000-point seed dataset | The first painted frame already has a full chart on it. A client that mounts empty, fetches, then paints shows an empty chart frame the user actually sees. |
| **Server** | Root layout, dashboard layout, `loading.tsx`, landing page | None of it needs the browser, so none of it should cost the client a byte. |
| **Edge** | `app/api/data/route.ts` | Pure arithmetic — no filesystem, no database, no Node built-in. Nothing to gain from a Node lambda, a lot to gain from starting in single-digit ms near the user. |
| **Client** | Charts, controls, table, providers | Everything touching canvas, pointer events or `requestAnimationFrame`. |

**What deliberately isn't there:** the dashboard page does *not* `fetch` its own `/api/data` route.
A Server Component calling its own route handler is a network round trip to reach a function already
in the same process. The route handler exists for clients.

### The seed payload: 750 KB → 110 KB

Handing the client `DataPoint[]` put **750 KB of HTML** on the critical path —
`{"timestamp":1785274688778,"value":45.41,"category":"cpu"}` is ~58 bytes and there are ten thousand
of them.

But samples are emitted round-robin across the channels at a fixed interval, so for point `i`:

```
category  = CATEGORIES[i % 8]
timestamp = startTime + floor(i / 8) * intervalMs
```

Both are derivable from the index. Sending only the values takes the document to **110 KB raw /
36 KB gzipped** — a 6.8× reduction with nothing lost. `/api/data` still speaks `DataPoint[]`,
because a public contract should be self-describing; this is an internal transport where the
opposite is true.

### Caching and the ISR seam

The dashboard page is ISR'd at `revalidate = 30`. Seed generation is deterministic, so it's
genuinely cacheable — but a cached payload can be half a minute old, and the live stream starts at
the *client's* `Date.now()`. Un-shifted, that leaves a visible dead zone between the last server
point and the first live one.

Hydration rebases every timestamp by the payload's age. It also corrects for client clock skew,
which is a real problem on machines whose time is a few seconds out.

The landing page is `force-static` — prerendered at build, zero client JS beyond the router.

### Bundle

```
Route (app)                    Size    First Load JS
┌ ○ /                          464 B         106 kB
├ ○ /_not-found                758 B         103 kB
├ ƒ /api/data                  127 B         103 kB
└ ○ /dashboard               20.6 kB         123 kB
+ First Load JS shared by all              103 kB
```

**123 KB** for the dashboard against a 500 KB gzipped budget. Three runtime dependencies (`next`,
`react`, `react-dom`) and no charting library — that number is mostly React itself. The worker is a
separate 3.2 KB chunk, loaded off the critical path. No `next/font`: the system stack renders
instantly with no network request and no layout shift.

---

## 7. Scaling

### Where the current design gives out

Stress mode (§1) is the honest answer: at **~15,000 points/second sustained** the median frame is
still 16.8 ms but the p95 is 50 ms — about one frame in twenty runs long. Three things stack up
there: the ingest loop, the 4Hz React notify, and the per-frame LOD pass over a much denser buffer.

### To 1,000,000 points

The ring buffers already handle it — 1M points is 12 MB of typed arrays, and writes stay O(1). What
breaks is the LOD pass, which is O(points in visible range) per frame.

The fix is a **hierarchical summary**: maintain pre-bucketed min/max at several resolutions (say 1s,
1m, 1h) updated incrementally on write, and have the renderer pick the coarsest level that still
exceeds the pixel column count. Draw cost then becomes O(columns) regardless of buffer size, and the
per-frame scan disappears entirely. This is the same idea as mipmapping.

### To 10ms updates

Decouple ingest rate from commit rate. The worker would accumulate into a double-buffered staging
array and hand over one merged batch per animation frame, so the main thread sees 60 writes/second
regardless of the source rate. `OffscreenCanvas` would then let the charts render in the worker too,
leaving the main thread doing nothing but input and layout.

### Server-side rendering at scale

Seed generation is the only server work, and it's ~30ms for 10,000 points at the edge. For real
telemetry the shape stays the same: the Server Component fetches a **pre-aggregated** window (the
database does the bucketing), streams it in the compact columnar form, and the client subscribes to
a delta feed over WebSocket or SSE. Server Components are exactly right for the seed; they're
exactly wrong for a 100ms stream.

### Offline

The buffers already live entirely in memory with a deterministic generator behind them. A service
worker caching the app shell plus IndexedDB persistence of the ring buffers on `visibilitychange`
would give a genuine offline mode. Reconnection would replay a delta from the last held timestamp.

### Real-time collaboration

Shared cursors and shared viewport state are small, high-frequency, last-write-wins values — a good
fit for a CRDT-free presence channel. The important design point is that they'd go through the same
path as everything else: presence lands in a ref, the render loop draws it, and React is never told.

---

## 8. Reproducing all of this

```bash
npm install
npm run build
npm start &
npm run bench
```

Requires Chrome or Chromium locally. `BENCH_DRIFT_MS` controls the memory window; `BENCH_JSON=1`
dumps raw results.

The harness refuses to report anything until it has confirmed the dashboard is alive and holding
data. An earlier version reported a rock-solid 60fps while the page was completely broken and
rendering nothing at all — every chart canvas silently stuck at its default 300×150 because the card
had no height to flex against. That is why the sanity gate exists.

That failure and the leak in §2 have the same shape, and it's the thing I'd take from this project:
**the metrics you'd naturally quote were both green while the app was broken.** 60fps meant nothing
when nothing was being drawn; a passing benchmark meant nothing while a React queue grew forever.
Neither was found by looking at a number — the first by opening a screenshot, the second by diffing
heap snapshots and walking a retainer chain.
