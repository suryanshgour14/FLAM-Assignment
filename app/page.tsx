import Link from 'next/link';
import styles from './home.module.css';

/**
 * Landing page.
 *
 * Fully static — no client component anywhere in this tree, so Next prerenders
 * it at build time and it ships zero JavaScript beyond the router. It exists
 * partly as a front door and partly to make the point that not every route in a
 * performance-critical app needs to be interactive.
 */

export const dynamic = 'force-static';

const SPECS = [
  { value: '100k+', label: 'points held in memory' },
  { value: '60 fps', label: 'during live ingest' },
  { value: '0', label: 'charting libraries' },
  { value: '~1.2 MB', label: 'buffer for 100k points' },
];

const NOTES = [
  {
    title: 'Columnar buffers',
    body: 'Samples live in per-channel Float64/Float32 ring buffers, not objects. Writes are O(1), the sliding window allocates nothing, and 100k points cost about 1.2 MB instead of 12.',
  },
  {
    title: 'Level of detail',
    body: 'A 1200px plot has 1200 usable columns. The visible range collapses to one min/max pair per column, so drawing cost tracks the viewport rather than the dataset.',
  },
  {
    title: 'React stays out of the loop',
    body: 'Data arriving never triggers a re-render. Canvases read a version counter inside a single shared rAF pass; React only hears about it at 4Hz, for the table.',
  },
  {
    title: 'Server-rendered seed',
    body: 'The first 10,000 points are generated in a Server Component and hydrated straight into the typed arrays, so the first painted frame already has a full chart on it.',
  },
];

export default function HomePage() {
  return (
    <div className={styles.page}>
      <section className={styles.hero}>
        <span className={styles.eyebrow}>
          <span className={styles.eyebrowDot} />
          Canvas + SVG, built from scratch
        </span>

        <h1 className={styles.title}>
          A dashboard that doesn&apos;t
          <br />
          drop frames.
        </h1>

        <p className={styles.subtitle}>
          Eight telemetry channels streaming live, up to 400,000 points retained, rendered on raw
          canvas with an SVG interaction layer. No Chart.js, no D3 — just typed arrays, a level-of-detail
          pass and one animation frame loop.
        </p>

        <div className={styles.actions}>
          <Link href="/dashboard" className={styles.cta} prefetch>
            Open the dashboard
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M3 8h10M9 4l4 4-4 4"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </Link>
          <a
            href="https://github.com/suryanshgour14/FLAM-Assignment"
            target="_blank"
            rel="noreferrer"
            className={`${styles.cta} ${styles.ctaGhost}`}
          >
            Source on GitHub
          </a>
        </div>
      </section>

      <section className={styles.specs}>
        {SPECS.map((s) => (
          <div key={s.label} className={styles.spec}>
            <div className={styles.specValue}>{s.value}</div>
            <div className={styles.specLabel}>{s.label}</div>
          </div>
        ))}
      </section>

      <section className={styles.notes}>
        {NOTES.map((n) => (
          <div key={n.title} className={styles.note}>
            <div className={styles.noteTitle}>{n.title}</div>
            <p className={styles.noteBody}>{n.body}</p>
          </div>
        ))}
      </section>

      <footer className={styles.footer}>
        Built by Suryansh Gour · full write-up in{' '}
        <a
          href="https://github.com/suryanshgour14/FLAM-Assignment/blob/main/PERFORMANCE.md"
          target="_blank"
          rel="noreferrer"
        >
          PERFORMANCE.md
        </a>
      </footer>
    </div>
  );
}
