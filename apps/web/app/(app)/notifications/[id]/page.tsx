'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { errorMessage } from '@/lib/api';
import { useNotification, useRetryDelivery } from '@/lib/hooks';
import { dateTime } from '@/lib/format';
import { DeliveryTimeline } from '@/components/delivery-timeline';
import { useToast } from '@/components/toast';
import { Card, ErrorNote, Loading, PageHeader } from '@/components/ui';

export default function NotificationDetailPage() {
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const q = useNotification(id); // polls while deliveries are in flight
  const retry = useRetryDelivery();

  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) return <ErrorNote error={q.error} />;
  const n = q.data;

  return (
    <>
      <Link href="/notifications" className="text-sm text-slate-500 hover:underline">
        ← Notifications
      </Link>
      <PageHeader
        title={n.title}
        description={`${n.id} · ${n.source} · ${n.priority} priority · ${dateTime(n.createdAt)}`}
      />

      {(n.body || n.data) && (
        <Card className="mb-6 space-y-3">
          {n.body && <p className="text-sm whitespace-pre-wrap">{n.body}</p>}
          {n.data && (
            <pre className="overflow-x-auto rounded-lg bg-slate-50 p-3 text-xs dark:bg-slate-800">
              {JSON.stringify(n.data, null, 2)}
            </pre>
          )}
        </Card>
      )}

      <h2 className="mb-3 font-medium">Delivery timeline</h2>
      <DeliveryTimeline
        deliveries={n.deliveries}
        retrying={retry.isPending ? retry.variables : undefined}
        onRetry={(deliveryId) =>
          retry.mutate(deliveryId, {
            onSuccess: () => toast('Retry scheduled'),
            onError: (e) => toast(errorMessage(e), 'error'),
          })
        }
      />
    </>
  );
}
