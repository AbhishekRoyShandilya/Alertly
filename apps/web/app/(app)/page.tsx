'use client';

import Link from 'next/link';
import { SUPPORTED_SYMBOLS } from '@alertly/shared';
import { useDeliveries, useDeliveryStats, usePrice, useUsage } from '@/lib/hooks';
import { percent, price, relativeTime } from '@/lib/format';
import { ChannelTag, StatusBadge } from '@/components/badges';
import { Sparkline, UsageChart } from '@/components/lazy-charts';
import { Card, EmptyState, Loading, PageHeader } from '@/components/ui';

function StatCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: string | number;
  tone?: string;
}) {
  return (
    <Card className="p-4">
      <p className="text-xs font-medium tracking-wide text-slate-500 uppercase">{label}</p>
      <p className={`mt-1 text-2xl font-semibold tabular-nums ${tone ?? ''}`}>{value}</p>
    </Card>
  );
}

function PriceTile({ symbol }: { symbol: string }) {
  const q = usePrice(symbol);
  return (
    <Card className="p-4">
      <div className="flex items-baseline justify-between">
        <p className="text-sm font-medium">{symbol.replace('USDT', '')}</p>
        <p className="text-sm tabular-nums">{q.data ? price(q.data.price) : '…'}</p>
      </div>
      <div className="mt-2">{q.data && <Sparkline points={q.data.history} />}</div>
    </Card>
  );
}

export default function DashboardPage() {
  const stats = useDeliveryStats();
  const usage = useUsage(30);
  const dead = useDeliveries({ status: 'dead' });
  const failed = useDeliveries({ status: 'failed' });
  const recentFailures = [
    ...(dead.data?.pages[0]?.data ?? []),
    ...(failed.data?.pages[0]?.data ?? []),
  ]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 6);
  const c = stats.data?.counts;
  const today = usage.data?.days.at(-1);

  return (
    <>
      <PageHeader title="Dashboard" description="Deliveries in the last 24 hours" />

      {stats.isLoading ? (
        <Loading />
      ) : (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
          <StatCard label="Delivered" value={c?.delivered ?? 0} tone="text-emerald-600" />
          <StatCard
            label="In flight"
            value={(c?.pending ?? 0) + (c?.sending ?? 0) + (c?.retrying ?? 0)}
          />
          <StatCard label="Failed" value={c?.failed ?? 0} tone={c?.failed ? 'text-red-600' : ''} />
          <StatCard label="Dead" value={c?.dead ?? 0} tone={c?.dead ? 'text-red-600' : ''} />
          <StatCard label="Success rate" value={percent(stats.data?.successRate)} />
        </div>
      )}

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <div className="mb-4 flex items-baseline justify-between">
            <h2 className="font-medium">Usage, last 30 days</h2>
            {usage.data && (
              <p className="text-xs text-slate-500">
                Today: {today?.notifications ?? 0} / {usage.data.dailyNotificationQuota}{' '}
                notifications
              </p>
            )}
          </div>
          {usage.data && usage.data.days.length > 0 ? (
            <UsageChart days={usage.data.days} />
          ) : (
            <p className="py-16 text-center text-sm text-slate-500">No usage yet.</p>
          )}
        </Card>

        <Card>
          <h2 className="mb-3 font-medium">Recent failures</h2>
          {recentFailures.length === 0 ? (
            <p className="text-sm text-slate-500">Nothing failed. 🎉</p>
          ) : (
            <ul className="space-y-3">
              {recentFailures.map((d) => (
                <li key={d.id} className="text-sm">
                  <Link
                    href={`/notifications/${d.notificationId}`}
                    className="flex items-center justify-between gap-2 hover:underline"
                  >
                    <ChannelTag type={d.channelType} name={d.channelName} />
                    <StatusBadge status={d.status} />
                  </Link>
                  <p className="truncate text-xs text-slate-500" title={d.lastError ?? ''}>
                    {d.lastError} · {relativeTime(d.updatedAt)}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <h2 className="mt-8 mb-3 font-medium">Prices (simulated feed)</h2>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4 lg:grid-cols-7">
        {SUPPORTED_SYMBOLS.map((s) => (
          <PriceTile key={s} symbol={s} />
        ))}
      </div>

      {stats.data && Object.values(stats.data.counts).every((n) => n === 0) && (
        <div className="mt-8">
          <EmptyState
            title="No deliveries yet"
            description="Add a channel and send a test, or create an alert rule."
            action={
              <Link href="/channels" className="text-sm font-medium text-brand-600 hover:underline">
                Add your first channel →
              </Link>
            }
          />
        </div>
      )}
    </>
  );
}
