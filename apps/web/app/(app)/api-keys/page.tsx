'use client';

import { useState, type FormEvent } from 'react';
import { errorMessage } from '@/lib/api';
import { useApiKeys, useCreateApiKey, useRevokeApiKey } from '@/lib/hooks';
import { dateTime, relativeTime } from '@/lib/format';
import { CopySecret } from '@/components/copy-secret';
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
  Table,
  Td,
} from '@/components/ui';

export default function ApiKeysPage() {
  const toast = useToast();
  const keys = useApiKeys();
  const create = useCreateApiKey();
  const revoke = useRevokeApiKey();
  const [name, setName] = useState('');
  const [newKey, setNewKey] = useState<string | null>(null);

  function submit(e: FormEvent) {
    e.preventDefault();
    create.mutate(name, {
      onSuccess: (k) => {
        setNewKey(k.key);
        setName('');
      },
      onError: (err) => toast(errorMessage(err), 'error'),
    });
  }

  return (
    <>
      <PageHeader
        title="API keys"
        description="Use a key to send notifications from your own servers: Authorization: Bearer alr_…"
      />

      {newKey && (
        <div className="mb-6">
          <CopySecret label="Your new API key" value={newKey} onDone={() => setNewKey(null)} />
        </div>
      )}

      <Card className="mb-6">
        <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
          <div className="min-w-60 flex-1">
            <Field
              label="Key name"
              htmlFor="key-name"
              hint='Where it will be used, e.g. "production server"'
            >
              <Input
                id="key-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={100}
              />
            </Field>
          </div>
          <Button type="submit" loading={create.isPending} disabled={!name.trim()}>
            Create key
          </Button>
        </form>
      </Card>

      {keys.isLoading && <Loading />}
      {keys.error && <ErrorNote error={keys.error} />}
      {keys.data?.data.length === 0 && <EmptyState title="No API keys yet" />}

      {keys.data && keys.data.data.length > 0 && (
        <Table head={['Name', 'Key', 'Last used', 'Created', '']}>
          {keys.data.data.map((k) => (
            <tr key={k.id} className={k.revokedAt ? 'opacity-50' : ''}>
              <Td className="font-medium">{k.name}</Td>
              <Td className="font-mono text-xs">{k.prefix}…</Td>
              <Td className="text-xs text-slate-500">
                {k.lastUsedAt ? relativeTime(k.lastUsedAt) : 'never'}
              </Td>
              <Td className="text-xs text-slate-500">{dateTime(k.createdAt)}</Td>
              <Td className="text-right">
                {k.revokedAt ? (
                  <span className="text-xs text-slate-500">
                    revoked {relativeTime(k.revokedAt)}
                  </span>
                ) : (
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={() =>
                      confirm(
                        `Revoke "${k.name}"? Programs using it will stop working immediately.`,
                      ) &&
                      revoke.mutate(k.id, {
                        onSuccess: () => toast('Key revoked'),
                        onError: (e) => toast(errorMessage(e), 'error'),
                      })
                    }
                  >
                    Revoke
                  </Button>
                )}
              </Td>
            </tr>
          ))}
        </Table>
      )}
    </>
  );
}
