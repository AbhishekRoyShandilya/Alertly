'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { errorMessage } from '@/lib/api';
import {
  useAlert,
  useChannels,
  useDeleteAlert,
  useDryRun,
  usePrice,
  useUpdateAlert,
} from '@/lib/hooks';
import { CONDITION_LABEL, dateTime, price, relativeTime } from '@/lib/format';
import { AlertStateBadge } from '@/components/badges';
import { Sparkline } from '@/components/lazy-charts';
import { useToast } from '@/components/toast';
import { Button, Card, ErrorNote, Loading, PageHeader, Table, Td } from '@/components/ui';

export default function AlertDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const toast = useToast();
  const alert = useAlert(id);
  const channels = useChannels();
  const dry = useDryRun();
  const update = useUpdateAlert();
  const remove = useDeleteAlert();
  const priceQ = usePrice(alert.data?.symbol ?? 'BTCUSDT');

  if (alert.isLoading) return <Loading />;
  if (alert.error || !alert.data) return <ErrorNote error={alert.error} />;
  const a = alert.data;
  const channelNames = a.channelIds.map(
    (cid) => channels.data?.data.find((c) => c.id === cid)?.name ?? cid,
  );

  return (
    <>
      <Link href="/alerts" className="text-sm text-slate-500 hover:underline">
        ← Alert rules
      </Link>
      <PageHeader
        title={a.name}
        description={`${a.symbol} ${CONDITION_LABEL[a.conditionType]} ${
          a.conditionType === 'pct_move'
            ? `${a.threshold}% within ${a.windowMinutes} minutes`
            : price(a.threshold)
        } · cooldown ${a.cooldownMinutes} min`}
        action={
          <div className="flex gap-2">
            <Button
              variant="secondary"
              onClick={() =>
                update.mutate(
                  { id, isActive: !a.isActive },
                  { onError: (e) => toast(errorMessage(e), 'error') },
                )
              }
            >
              {a.isActive ? 'Pause' : 'Resume'}
            </Button>
            <Button
              variant="danger"
              onClick={() =>
                confirm('Delete this alert rule?') &&
                remove.mutate(id, {
                  onSuccess: () => router.replace('/alerts'),
                  onError: (e) => toast(errorMessage(e), 'error'),
                })
              }
            >
              Delete
            </Button>
          </div>
        }
      />

      <div className="grid gap-6 lg:grid-cols-3">
        <Card>
          <p className="text-xs font-medium tracking-wide text-slate-500 uppercase">State</p>
          <div className="mt-2">
            <AlertStateBadge state={a.state} active={a.isActive} />
          </div>
          <dl className="mt-4 space-y-2 text-sm">
            <div className="flex justify-between">
              <dt className="text-slate-500">Last evaluated price</dt>
              <dd className="tabular-nums">{price(a.lastPrice)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-500">Last triggered</dt>
              <dd>{relativeTime(a.lastTriggeredAt)}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-slate-500">Channels</dt>
              <dd className="text-right">{channelNames.join(', ')}</dd>
            </div>
          </dl>
        </Card>

        <Card className="lg:col-span-2">
          <div className="flex items-baseline justify-between">
            <p className="text-xs font-medium tracking-wide text-slate-500 uppercase">
              {a.symbol}, last 24 h
            </p>
            <p className="text-lg font-semibold tabular-nums">
              {priceQ.data ? price(priceQ.data.price) : '…'}
            </p>
          </div>
          <div className="mt-2">
            {priceQ.data && <Sparkline points={priceQ.data.history} height={120} />}
          </div>
        </Card>
      </div>

      <Card className="mt-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-medium">Dry run</h2>
            <p className="text-sm text-slate-500">
              Would this rule fire at the current price? Nothing is saved or sent.
            </p>
          </div>
          <Button variant="secondary" loading={dry.isPending} onClick={() => dry.mutate(id)}>
            Evaluate now
          </Button>
        </div>
        {dry.data && (
          <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-sm dark:bg-slate-800">
            <strong>{dry.data.fire ? 'Would fire' : 'Would not fire'}</strong> at{' '}
            {price(dry.data.price)}: {dry.data.reason} → next state{' '}
            <code>{dry.data.nextState}</code>
          </p>
        )}
        {dry.error && (
          <div className="mt-3">
            <ErrorNote error={new Error(errorMessage(dry.error))} />
          </div>
        )}
      </Card>

      <h2 className="mt-8 mb-3 font-medium">Trigger history</h2>
      {a.events.length === 0 ? (
        <p className="text-sm text-slate-500">This rule hasn’t fired yet.</p>
      ) : (
        <Table head={['When', 'Price', 'Threshold', 'Notification']}>
          {a.events.map((e) => (
            <tr key={e.id}>
              <Td className="text-xs">{dateTime(e.triggeredAt)}</Td>
              <Td className="tabular-nums">{price(e.price)}</Td>
              <Td className="tabular-nums">
                {e.conditionType === 'pct_move' ? `${e.threshold}%` : price(e.threshold)}
              </Td>
              <Td>
                {e.notificationId ? (
                  <Link
                    href={`/notifications/${e.notificationId}`}
                    className="text-sm text-brand-600 hover:underline"
                  >
                    View deliveries →
                  </Link>
                ) : (
                  <span className="text-xs text-slate-400">not sent</span>
                )}
              </Td>
            </tr>
          ))}
        </Table>
      )}
    </>
  );
}
