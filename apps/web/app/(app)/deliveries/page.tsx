'use client';

import { useState } from 'react';
import Link from 'next/link';
import { DELIVERY_STATUSES } from '@alertly/shared';
import { errorMessage } from '@/lib/api';
import { useDeliveries, useRetryDelivery } from '@/lib/hooks';
import { dateTime, relativeTime } from '@/lib/format';
import { ChannelTag, StatusBadge } from '@/components/badges';
import { useToast } from '@/components/toast';
import {
  Button,
  EmptyState,
  ErrorNote,
  Loading,
  PageHeader,
  Select,
  Table,
  Td,
} from '@/components/ui';

export default function DeliveriesPage() {
  const toast = useToast();
  const [status, setStatus] = useState('');
  const q = useDeliveries({ status: status || undefined });
  const retry = useRetryDelivery();
  const rows = q.data?.pages.flatMap((p) => p.data) ?? [];

  return (
    <>
      <PageHeader
        title="Deliveries"
        description="One row per notification per channel. Failed and dead deliveries can be retried."
        action={
          <Select
            aria-label="Filter by status"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="w-40"
          >
            <option value="">All statuses</option>
            {DELIVERY_STATUSES.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </Select>
        }
      />

      {q.isLoading && <Loading />}
      {q.error && <ErrorNote error={q.error} />}
      {q.data && rows.length === 0 && <EmptyState title="No deliveries match" />}

      {rows.length > 0 && (
        <>
          <Table
            head={[
              'Channel',
              'Status',
              'Attempts',
              'Last error',
              'Next / delivered',
              'Created',
              '',
            ]}
          >
            {rows.map((d) => (
              <tr key={d.id}>
                <Td>
                  <Link href={`/notifications/${d.notificationId}`} className="hover:underline">
                    <ChannelTag type={d.channelType} name={d.channelName} />
                  </Link>
                </Td>
                <Td>
                  <StatusBadge status={d.status} />
                </Td>
                <Td className="text-xs tabular-nums">
                  {d.attemptCount}/{d.maxAttempts}
                </Td>
                <Td className="max-w-64 truncate font-mono text-xs text-red-600">
                  <span title={d.lastError ?? ''}>{d.lastError ?? ''}</span>
                </Td>
                <Td className="text-xs whitespace-nowrap text-slate-500">
                  {d.deliveredAt
                    ? `delivered ${relativeTime(d.deliveredAt)}`
                    : d.nextAttemptAt
                      ? `retry ${relativeTime(d.nextAttemptAt)}`
                      : '—'}
                </Td>
                <Td className="text-xs whitespace-nowrap text-slate-500">
                  {dateTime(d.createdAt)}
                </Td>
                <Td className="text-right">
                  {(d.status === 'failed' || d.status === 'dead') && (
                    <Button
                      size="sm"
                      variant="secondary"
                      loading={retry.isPending && retry.variables === d.id}
                      onClick={() =>
                        retry.mutate(d.id, {
                          onSuccess: () => toast('Retry scheduled'),
                          onError: (e) => toast(errorMessage(e), 'error'),
                        })
                      }
                    >
                      Retry
                    </Button>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
          {q.hasNextPage && (
            <div className="mt-4 text-center">
              <Button
                variant="secondary"
                loading={q.isFetchingNextPage}
                onClick={() => void q.fetchNextPage()}
              >
                Load more
              </Button>
            </div>
          )}
        </>
      )}
    </>
  );
}
