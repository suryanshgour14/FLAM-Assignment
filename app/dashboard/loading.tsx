import styles from './dashboard.module.css';
import ui from '@/components/ui/ui.module.css';

/**
 * Streamed fallback while the server generates the seed dataset.
 *
 * The skeleton mirrors the real grid geometry — same column split, same card
 * heights — so the swap doesn't shift anything. A generic centred spinner would
 * be less work and would cost real CLS.
 */
export default function DashboardLoading() {
  return (
    <div className={styles.loadingShell} aria-busy="true" aria-label="Loading dashboard">
      <div className={styles.header}>
        <div className={styles.brand}>
          <span className={styles.mark} aria-hidden="true">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path
                d="M1 10.5l3.2-4.2 2.6 2.9L10.2 3l4.3 7.5"
                stroke="#08090d"
                strokeWidth="1.9"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
          <span>
            <div className={styles.brandName}>Pulse</div>
            <div className={styles.brandTag}>generating seed dataset…</div>
          </span>
        </div>
      </div>

      <div className={styles.loadingSide}>
        {Array.from({ length: 9 }, (_, i) => (
          <div
            key={i}
            className={`${ui.skeleton} ${styles.loadingRow}`}
            style={{ opacity: 1 - i * 0.08 }}
          />
        ))}
      </div>

      <div className={styles.loadingMain}>
        <div className={`${ui.skeleton} ${styles.loadingCard} ${styles.loadingWide}`} />
        <div className={`${ui.skeleton} ${styles.loadingCard}`} />
        <div className={`${ui.skeleton} ${styles.loadingCard}`} />
        <div className={`${ui.skeleton} ${styles.loadingCard}`} />
        <div className={`${ui.skeleton} ${styles.loadingCard}`} />
      </div>
    </div>
  );
}
