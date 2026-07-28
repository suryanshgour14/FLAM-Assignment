'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import styles from './dashboard.module.css';

/**
 * Route-level error boundary.
 *
 * Must be a Client Component — `reset` is a callback and boundaries only work
 * on the client. It catches render and data errors in the segment; note that it
 * does *not* catch a throw inside a rAF callback, which is why the render
 * scheduler try/catches each renderer itself.
 */
export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // In a real deployment this is where the error would go to Sentry et al.
    console.error('[dashboard] render failed', error);
  }, [error]);

  return (
    <div className={styles.errorWrap}>
      <div className={styles.errorCard} role="alert">
        <div className={styles.errorIcon} aria-hidden="true">
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
            <path
              d="M10 6.5v4.2M10 13.8h.01M8.6 2.9L1.7 15.1c-.5.9.1 2 1.2 2h14.2c1.1 0 1.7-1.1 1.2-2L11.4 2.9c-.6-1-2.2-1-2.8 0z"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>

        <h1 className={styles.errorTitle}>The dashboard stopped rendering</h1>
        <p className={styles.errorText}>
          Something threw while drawing or streaming data. Retrying re-runs the segment with a
          fresh dataset; the buffers are rebuilt from scratch, so this is safe.
        </p>

        {error.digest && <div className={styles.errorDigest}>digest: {error.digest}</div>}

        <div className={styles.errorActions}>
          <button type="button" className={styles.errorBtn} onClick={reset}>
            Try again
          </button>
          <Link href="/" className={`${styles.errorBtn} ${styles.errorBtnGhost}`}>
            Back home
          </Link>
        </div>
      </div>
    </div>
  );
}
