import Link from 'next/link';
import styles from './dashboard/dashboard.module.css';

export default function NotFound() {
  return (
    <div className={styles.errorWrap}>
      <div className={styles.errorCard}>
        <h1 className={styles.errorTitle}>404 — nothing here</h1>
        <p className={styles.errorText}>
          This route doesn&apos;t exist. The dashboard lives at <code>/dashboard</code>.
        </p>
        <div className={styles.errorActions}>
          <Link href="/dashboard" className={styles.errorBtn}>
            Open the dashboard
          </Link>
          <Link href="/" className={`${styles.errorBtn} ${styles.errorBtnGhost}`}>
            Home
          </Link>
        </div>
      </div>
    </div>
  );
}
