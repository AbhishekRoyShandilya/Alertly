'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { errorMessage } from '@/lib/api';
import { useNotifications, useSendNotification } from '@/lib/hooks';
import { dateTime } from '@/lib/format';
import { useToast } from '@/components/toast';
import {
  Button,
  Card,
  EmptyState,
  ErrorNote,
  Field,
  Input,
  Loading,
  PageHeader,
  Select,
  Table,
  Td,
} from '@/components/ui';

function ComposeForm({ onSent }: { onSent: () => void }) {
  const toast = useToast();
  const send = useSendNotification();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [priority, setPriority] = useState<'normal' | 'high'>('normal');

  function submit(e: FormEvent) {
    e.preventDefault();
    send.mutate(
      { title, body, priority },
      {
        onSuccess: () => {
          toast('Notification queued for every active channel');
          setTitle('');
          setBody('');
          onSent();
        },
        onError: (err) => toast(errorMessage(err), 'error'),
      },
    );
  }

  return (
    <form onSubmit={submit} className="grid gap-4 sm:grid-cols-4">
      <div className="sm:col-span-2">
        <Field label="Title" htmlFor="n-title">
          <Input
            id="n-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
            maxLength={200}
          />
        </Field>
      </div>
      <Field label="Priority" htmlFor="n-priority">
        <Select
          id="n-priority"
          value={priority}
          onChange={(e) => setPriority(e.target.value as 'normal' | 'high')}
        >
          <option value="normal">normal</option>
          <option value="high">high</option>
        </Select>
      </Field>
      <div className="sm:col-span-4">
        <Field label="Body" htmlFor="n-body">
          <Input
            id="n-body"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            maxLength={4000}
          />
        </Field>
      </div>
      <div>
        <Button type="submit" loading={send.isPending} disabled={!title.trim()}>
          Send
        </Button>
      </div>
    </form>
  );
}

export default function NotificationsPage() {
  const [source, setSource] = useState('');
  const [compose, setCompose] = useState(false);
  const q = useNotifications({ source: source || undefined });
  const rows = q.data?.pages.flatMap((p) => p.data) ?? [];

  return (
    <>
      <PageHeader
        title="Notifications"
        description="Everything sent through Alertly, from the API, alert rules and channel tests."
        action={
          <div className="flex gap-2">
            <Select
              aria-label="Filter by source"
              value={source}
              onChange={(e) => setSource(e.target.value)}
              className="w-36"
            >
              <option value="">All sources</option>
              <option value="api">API</option>
              <option value="alert">Alerts</option>
              <option value="test">Tests</option>
            </Select>
            <Button onClick={() => setCompose((c) => !c)}>{compose ? 'Close' : 'Send one'}</Button>
          </div>
        }
      />

      {compose && (
        <Card className="mb-6">
          <ComposeForm onSent={() => setCompose(false)} />
        </Card>
      )}

      {q.isLoading && <Loading />}
      {q.error && <ErrorNote error={q.error} />}
      {q.data && rows.length === 0 && (
        <EmptyState
          title="No notifications yet"
          description="Send one with the API, or test a channel."
        />
      )}

      {rows.length > 0 && (
        <>
          <Table head={['Title', 'Source', 'Priority', 'Created']}>
            {rows.map((n) => (
              <tr key={n.id}>
                <Td>
                  <Link href={`/notifications/${n.id}`} className="font-medium hover:underline">
                    {n.title}
                  </Link>
                  {n.body && <p className="max-w-md truncate text-xs text-slate-500">{n.body}</p>}
                </Td>
                <Td className="text-xs">{n.source}</Td>
                <Td className="text-xs">
                  {n.priority === 'high' ? <strong>high</strong> : 'normal'}
                </Td>
                <Td className="text-xs whitespace-nowrap text-slate-500">
                  {dateTime(n.createdAt)}
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
