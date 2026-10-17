'use client';

import dynamic from 'next/dynamic';

// Lazy-loaded chart components (see charts.tsx for why).
const placeholder = (h: number) => () => (
  <div style={{ height: h }} className="animate-pulse rounded-lg bg-slate-100 dark:bg-slate-800" />
);

export const UsageChart = dynamic(() => import('./charts'), {
  ssr: false,
  loading: placeholder(220),
});
export const Sparkline = dynamic(() => import('./charts').then((m) => m.Sparkline), {
  ssr: false,
  loading: placeholder(40),
});
