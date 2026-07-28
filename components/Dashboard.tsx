'use client';

import { memo, useState } from 'react';
import styles from '@/app/dashboard/dashboard.module.css';
import { LineChart } from '@/components/charts/LineChart';
import { BarChart } from '@/components/charts/BarChart';
import { ScatterPlot } from '@/components/charts/ScatterPlot';
import { Heatmap } from '@/components/charts/Heatmap';
import { FilterPanel } from '@/components/controls/FilterPanel';
import { TimeRangeSelector } from '@/components/controls/TimeRangeSelector';
import { LoadControls } from '@/components/controls/LoadControls';
import { DataTable } from '@/components/ui/DataTable';
import { PerformanceMonitor } from '@/components/ui/PerformanceMonitor';
import { HeaderStats } from '@/components/ui/HeaderStats';

/**
 * The dashboard shell.
 *
 * Its only state is whether the mobile drawer is open. Everything else lives in
 * the provider or inside the individual panels — which is the point: this
 * component re-renders roughly twice in the life of the page, so nothing below
 * it ever re-renders because of a parent.
 */
function DashboardImpl() {
  const [navOpen, setNavOpen] = useState(false);

  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <button
          type="button"
          className={styles.menuBtn}
          onClick={() => setNavOpen((v) => !v)}
          aria-label={navOpen ? 'Close controls' : 'Open controls'}
          aria-expanded={navOpen}
        >
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path
              d="M2 4h12M2 8h12M2 12h12"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
            />
          </svg>
        </button>

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
            <div className={styles.brandTag}>real-time telemetry</div>
          </span>
        </div>

        <HeaderStats />
      </header>

      {navOpen && (
        <div
          className={styles.backdrop}
          onClick={() => setNavOpen(false)}
          role="presentation"
          aria-hidden="true"
        />
      )}

      <aside className={`${styles.sidebar} ${navOpen ? styles.sidebarOpen : ''}`}>
        <div className={styles.sidebarGroup}>
          <span className={styles.groupTitle}>Performance</span>
          <PerformanceMonitor />
        </div>

        <div className={styles.sidebarGroup}>
          <span className={styles.groupTitle}>View</span>
          <TimeRangeSelector />
          <FilterPanel />
        </div>

        <div className={styles.sidebarGroup}>
          <span className={styles.groupTitle}>Load</span>
          <LoadControls />
        </div>
      </aside>

      <main className={styles.main}>
        <div className={styles.chartGrid}>
          <div className={styles.spanFull}>
            <LineChart />
          </div>
          <div className={styles.chartCell}>
            <BarChart />
          </div>
          <div className={styles.chartCell}>
            <ScatterPlot />
          </div>
          <div className={styles.chartCell}>
            <Heatmap />
          </div>
          <div className={`${styles.tableCell} ${styles.chartCell}`}>
            <DataTable />
          </div>
        </div>
      </main>
    </div>
  );
}

export const Dashboard = memo(DashboardImpl);
export default Dashboard;
