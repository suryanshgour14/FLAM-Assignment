import type { ChartConfig } from './types';

/**
 * Chart definitions.
 *
 * Deliberately a plain module rather than client state: none of it changes at
 * runtime, so it can be read by a Server Component, serialised into the initial
 * HTML, and never shipped as mutable client state. It's the "static generation
 * for chart configurations" bonus, done the boring way that actually works.
 */
export const CHART_CONFIGS: ChartConfig[] = [
  {
    id: 'line',
    type: 'line',
    title: 'Time Series',
    subtitle: 'Min/max level-of-detail · scroll to zoom, drag to pan',
    dataKey: 'value',
    color: '#6ea8fe',
    visible: true,
  },
  {
    id: 'bar',
    type: 'bar',
    title: 'Windowed Aggregate',
    subtitle: 'Mean per bucket with min–max whiskers',
    dataKey: 'value',
    color: '#2dd4bf',
    visible: true,
  },
  {
    id: 'scatter',
    type: 'scatter',
    title: 'Distribution',
    subtitle: 'Every retained sample, additively blended',
    dataKey: 'value',
    color: '#f5a524',
    visible: true,
  },
  {
    id: 'heatmap',
    type: 'heatmap',
    title: 'Density Map',
    subtitle: 'Channel × time occupancy, drawn via ImageData',
    dataKey: 'value',
    color: '#f472b6',
    visible: true,
  },
];

/** Points the server pre-renders into the first paint. */
export const INITIAL_POINT_COUNT = 10_000;

export const DEFAULT_SEED = 20240607;
