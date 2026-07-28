import type { Metadata, Viewport } from 'next';
import './globals.css';

/**
 * Root layout — a Server Component, and it stays one. Nothing here needs the
 * browser, so none of it should cost the client a byte.
 *
 * No `next/font` on purpose: the system font stack renders instantly with zero
 * network requests and zero layout shift, and on a dashboard that is looked at
 * for hours the marginal value of a custom typeface is close to nil. It also
 * keeps the LCP honest.
 */

export const metadata: Metadata = {
  title: {
    default: 'Pulse — Real-time Telemetry Dashboard',
    template: '%s · Pulse',
  },
  description:
    'A real-time data visualisation dashboard rendering 100,000+ points at 60fps. Canvas and SVG hybrid rendering built from scratch — no charting libraries.',
  applicationName: 'Pulse',
  authors: [{ name: 'Suryansh Gour' }],
  keywords: ['dashboard', 'real-time', 'canvas', 'data visualisation', 'next.js', 'performance'],
  openGraph: {
    title: 'Pulse — Real-time Telemetry Dashboard',
    description: '100,000+ points at 60fps. Canvas + SVG, built from scratch.',
    type: 'website',
  },
};

export const viewport: Viewport = {
  themeColor: '#08090d',
  width: 'device-width',
  initialScale: 1,
  // Charts own the pinch gesture for zoom; leaving browser zoom on top of that
  // makes the interaction ambiguous on touch devices.
  maximumScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
