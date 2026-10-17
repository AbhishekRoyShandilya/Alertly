'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { Channel } from '@alertly/shared';
import { errorMessage } from '@/lib/api';
import {
  useChannels,
  useCreateChannel,
  useDeleteChannel,
  useNotification,
  useRotateSecret,
  useTestChannel,
  useUpdateChannel,
} from '@/lib/hooks';
import { relativeTime } from '@/lib/format';
import { ChannelForm } from '@/components/channel-form';
import { CopySecret } from '@/components/copy-secret';
import { ChannelTag, StatusBadge } from '@/components/badges';
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

/** After "Test", polls the test notification until its delivery is final, then shows the result. */
function TestResult({ notificationId }: { notificationId: string }) {
  const q = useNotification(notificationId);
  const d = q.data?.deliveries[0];
  if (!d) return <span className="text-xs text-slate-500">queued…</span>;
  return (
    <Link
      href={`/notifications/${notificationId}`}
      className="inline-flex items-center gap-1 text-xs hover:underline"
    >
      <StatusBadge status={d.status} />
    </Link>
  );
}

function configSummary(c: Channel): string {
  const v = c.config.to ?? c.config.url ?? c.config.chatId;
  return typeof v === 'string' ? v : '';
}

export default function ChannelsPage() {
  const toast = useToast();
  const channels = useChannels();
  const create = useCreateChannel();
  const update = useUpdateChannel();
  const remove = useDeleteChannel();
  const test = useTestChannel();
  const rotate = useRotateSecret();
  const [showForm, setShowForm] = useState(false);
  const [secret, setSecret] = useState<{ label: string; value: string } | null>(null);
  const [tests, setTests] = useState<Record<string, string>>({});

  const onError = (e: unknown) => toast(errorMessage(e), 'error');

  return (
    <>
      <PageHeader
        title="Channels"
        description="Where notifications are delivered. Test each one after adding it."
        action={
          <Button onClick={() => setShowForm((s) => !s)}>
            {showForm ? 'Close' : 'Add channel'}
          </Button>
        }
      />

      {secret && (
        <div className="mb-6">
          <CopySecret label={secret.label} value={secret.value} onDone={() => setSecret(null)} />
        </div>
      )}

      {showForm && (
        <Card className="mb-6">
          <ChannelForm
            submitting={create.isPending}
            onSubmit={(input) =>
              create.mutate(input, {
                onSuccess: (ch) => {
                  setShowForm(false);
                  toast(`Channel "${ch.name}" added`);
                  if (ch.secret)
                    setSecret({ label: `Signing secret for "${ch.name}"`, value: ch.secret });
                },
                onError,
              })
            }
          />
        </Card>
      )}

      {channels.isLoading && <Loading />}
      {channels.error && <ErrorNote error={channels.error} />}
      {channels.data?.data.length === 0 && !showForm && (
        <EmptyState
          title="No channels yet"
          description="Add an email address, a webhook URL or a Telegram chat."
          action={<Button onClick={() => setShowForm(true)}>Add your first channel</Button>}
        />
      )}

      {channels.data && channels.data.data.length > 0 && (
        <Table head={['Channel', 'Destination', 'Status', 'Verified', 'Last test', '']}>
          {channels.data.data.map((c) => (
            <tr key={c.id}>
              <Td>
                <ChannelTag type={c.type} name={c.name} />
              </Td>
              <Td className="max-w-56 truncate font-mono text-xs text-slate-500">
                {configSummary(c)}
              </Td>
              <Td>
                <button
                  className="text-xs font-medium text-slate-600 hover:underline dark:text-slate-300"
                  onClick={() =>
                    update.mutate(
                      { id: c.id, status: c.status === 'active' ? 'disabled' : 'active' },
                      { onError },
                    )
                  }
                  title="Click to toggle"
                >
                  {c.status === 'active' ? '● active' : '○ disabled'}
                </button>
              </Td>
              <Td className="text-xs text-slate-500">
                {c.verifiedAt ? relativeTime(c.verifiedAt) : 'not yet'}
              </Td>
              <Td>
                {tests[c.id] ? (
                  <TestResult notificationId={tests[c.id]!} />
                ) : (
                  <span className="text-xs text-slate-400">—</span>
                )}
              </Td>
              <Td className="text-right whitespace-nowrap">
                <div className="flex justify-end gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={test.isPending && test.variables === c.id}
                    disabled={c.status !== 'active'}
                    onClick={() =>
                      test.mutate(c.id, {
                        onSuccess: (r) => setTests((t) => ({ ...t, [c.id]: r.notificationId })),
                        onError,
                      })
                    }
                  >
                    Test
                  </Button>
                  {c.type === 'webhook' && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        confirm(
                          'Rotate the signing secret? Your receiver must switch to the new one.',
                        ) &&
                        rotate.mutate(c.id, {
                          onSuccess: (r) =>
                            r.secret &&
                            setSecret({
                              label: `New signing secret for "${c.name}"`,
                              value: r.secret,
                            }),
                          onError,
                        })
                      }
                    >
                      Rotate secret
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={() =>
                      confirm(`Delete channel "${c.name}"?`) &&
                      remove.mutate(c.id, { onSuccess: () => toast('Channel deleted'), onError })
                    }
                  >
                    Delete
                  </Button>
                </div>
              </Td>
            </tr>
          ))}
        </Table>
      )}
    </>
  );
}
