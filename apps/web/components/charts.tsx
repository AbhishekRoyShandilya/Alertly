'use client';

import type { PricePoint, UsageDay } from '@alertly/shared';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

/*
 * Recharts is large (~100 kB gzipped) and only needed on two screens. These components are
 * imported with next/dynamic({ ssr: false }), so the library is split into its own chunk and
 * downloaded only when a chart is actually shown (code splitting / lazy loading).
 */

export default function UsageChart({ days }: { days: UsageDay[] }) {
  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={days} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
        <CartesianGrid
          strokeDasharray="3 3"
          vertical={false}
          stroke="currentColor"
          strokeOpacity={0.1}
        />
        <XAxis
          dataKey="day"
          tickFormatter={(d: string) => d.slice(5)}
          fontSize={11}
          tickLine={false}
        />
        <YAxis allowDecimals={false} fontSize={11} tickLine={false} axisLine={false} />
        <Tooltip />
        <Bar
          dataKey="notifications"
          name="Notifications"
          fill="oklch(0.53 0.21 270)"
          radius={[3, 3, 0, 0]}
        />
        <Bar
          dataKey="deliveries"
          name="Deliveries"
          fill="oklch(0.75 0.12 200)"
          radius={[3, 3, 0, 0]}
        />
      </BarChart>
    </ResponsiveContainer>
  );
}

export function Sparkline({ points, height = 40 }: { points: PricePoint[]; height?: number }) {
  if (points.length < 2)
    return (
      <div style={{ height }} className="text-xs text-slate-400">
        collecting…
      </div>
    );
  const up = points[points.length - 1]!.price >= points[0]!.price;
  const color = up ? 'oklch(0.65 0.17 155)' : 'oklch(0.6 0.2 25)';
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={points} margin={{ top: 2, right: 0, left: 0, bottom: 2 }}>
        <YAxis hide domain={['dataMin', 'dataMax']} />
        <Area
          type="monotone"
          dataKey="price"
          stroke={color}
          fill={color}
          fillOpacity={0.12}
          strokeWidth={1.5}
          dot={false}
          isAnimationActive={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
