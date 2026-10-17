'use client';

import { useState } from 'react';
import Link from 'next/link';
import { errorMessage } from '@/lib/api';
import { useAlerts, useChannels, useCreateAlert, usePrice, useUpdateAlert } from '@/lib/hooks';
import { CONDITION_LABEL, price, relativeTime } from '@/lib/format';
import { AlertForm } from '@/components/alert-form';
import { AlertStateBadge } from '@/components/badges';
import { Sparkline } from '@/components/lazy-charts';
import { useToast } from '@/components/toast';
import {
  Button,
  Card,
  EmptyState,
  ErrorNote,
  Loading,
  PageHeader,
  Table,
  Td,
} from '@/components/ui';

function SymbolCell({ symbol }: { symbol: string }) {
  const q = usePrice(symbol);
  return (
    <div className="w-36">
      <div className="flex justify-between text-xs">
        <span className="font-medium">{symbol}</span>
        <span className="tabular-nums text-slate-500">{q.data ? price(q.data.price) : ''}</span>
      </div>
      {q.data && <Sparkline points={q.data.history} height={28} />}
    </div>
  );
}

export default function AlertsPage() {
  const toast = useToast();
  const alerts = useAlerts();
  const channels = useChannels();
  const create = useCreateAlert();
  const update = useUpdateAlert();
  const [showForm, setShowForm] = useState(false);
  const activeChannels = channels.data?.data.filter((c) => c.status === 'active') ?? [];

  return (
    <>
      <PageHeader
        title="Alert rules"
        description="Price conditions checked every 15 seconds. Each rule notifies once, then waits for the condition to reset."
        action={
          <Button
            onClick={() => setShowForm((s) => !s)}
            disabled={activeChannels.length === 0 && !showForm}
          >
            {showForm ? 'Close' : 'New alert'}
          </Button>
        }
      />

      {channels.data && activeChannels.length === 0 && (
        <p className="mb-6 text-sm text-slate-500">
          Alerts need somewhere to go.{' '}
          <Link href="/channels" className="font-medium text-brand-600 hover:underline">
            Add a channel first →
          </Link>
        </p>
      )}

      {showForm && (
        <Card className="mb-6">
          <AlertForm
            channels={activeChannels}
            submitting={create.isPending}
            onSubmit={(input) =>
              create.mutate(input, {
                onSuccess: () => {
                  setShowForm(false);
                  toast('Alert created');
                },
                onError: (e) => toast(errorMessage(e), 'error'),
              })
            }
          />
        </Card>
      )}

      {alerts.isLoading && <Loading />}
      {alerts.error && <ErrorNote error={alerts.error} />}
      {alerts.data?.data.length === 0 && !showForm && activeChannels.length > 0 && (
        <EmptyState
          title="No alert rules yet"
          description='For example: "BTC crosses above 70,000".'
          action={<Button onClick={() => setShowForm(true)}>Create your first alert</Button>}
        />
      )}

      {alerts.data && alerts.data.data.length > 0 && (
        <Table head={['Rule', 'Condition', 'Market', 'State', 'Last triggered', 'Active']}>
          {alerts.data.data.map((a) => (
            <tr key={a.id}>
              <Td>
                <Link href={`/alerts/${a.id}`} className="font-medium hover:underline">
                  {a.name}
                </Link>
              </Td>
              <Td className="text-xs whitespace-nowrap text-slate-600 dark:text-slate-300">
                {CONDITION_LABEL[a.conditionType]}{' '}
                {a.conditionType === 'pct_move'
                  ? `${a.threshold}% in ${a.windowMinutes} min`
                  : price(a.threshold)}
              </Td>
              <Td>
                <SymbolCell symbol={a.symbol} />
              </Td>
              <Td>
                <AlertStateBadge state={a.state} active={a.isActive} />
              </Td>
              <Td className="text-xs text-slate-500">{relativeTime(a.lastTriggeredAt)}</Td>
              <Td>
                {/* Optimistic toggle: flips immediately, rolls back if the API refuses. */}
                <label className="inline-flex cursor-pointer items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    role="switch"
                    checked={a.isActive}
                    onChange={(e) =>
                      update.mutate(
                        { id: a.id, isActive: e.target.checked },
                        { onError: (err) => toast(errorMessage(err), 'error') },
                      )
                    }
                    className="accent-brand-600"
                  />
                  {a.isActive ? 'on' : 'paused'}
                </label>
              </Td>
            </tr>
          ))}
        </Table>
      )}
    </>
  );
}
