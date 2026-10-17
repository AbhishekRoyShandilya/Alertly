'use client';

import { useState, type FormEvent } from 'react';
import { CreateChannelInput, type ChannelType } from '@alertly/shared';
import { Button, Field, Input, Select } from './ui';

const CONFIG_FIELD: Record<
  ChannelType,
  { key: string; label: string; placeholder: string; hint?: string }
> = {
  email: { key: 'to', label: 'Email address', placeholder: 'ops@example.com' },
  webhook: {
    key: 'url',
    label: 'Webhook URL',
    placeholder: 'https://example.com/hooks/alertly',
    hint: 'Private and internal addresses are refused (SSRF protection)',
  },
  telegram: {
    key: 'chatId',
    label: 'Telegram chat id',
    placeholder: '123456789',
    hint: 'Message the Alertly bot, then use your chat id (e.g. from @userinfobot)',
  },
};

/** Type-specific fields; validated with the shared discriminated-union schema before sending. */
export function ChannelForm({
  onSubmit,
  submitting,
}: {
  onSubmit: (input: CreateChannelInput) => void;
  submitting?: boolean;
}) {
  const [type, setType] = useState<ChannelType>('email');
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const field = CONFIG_FIELD[type];

  function submit(e: FormEvent) {
    e.preventDefault();
    const parsed = CreateChannelInput.safeParse({
      type,
      name,
      config: { [field.key]: value.trim() },
    });
    if (!parsed.success) {
      setErrors(Object.fromEntries(parsed.error.issues.map((i) => [String(i.path[0]), i.message])));
      return;
    }
    setErrors({});
    onSubmit(parsed.data);
  }

  return (
    <form onSubmit={submit} className="grid gap-4 sm:grid-cols-3" noValidate>
      <Field label="Type" htmlFor="ch-type">
        <Select
          id="ch-type"
          value={type}
          onChange={(e) => {
            setType(e.target.value as ChannelType);
            setValue('');
          }}
        >
          <option value="email">Email</option>
          <option value="webhook">Webhook</option>
          <option value="telegram">Telegram</option>
        </Select>
      </Field>
      <Field label="Name" htmlFor="ch-name" error={errors.name}>
        <Input
          id="ch-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="On-call inbox"
        />
      </Field>
      <Field label={field.label} htmlFor="ch-value" hint={field.hint} error={errors.config}>
        <Input
          id="ch-value"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={field.placeholder}
        />
      </Field>
      <div className="sm:col-span-3">
        <Button type="submit" loading={submitting}>
          Add channel
        </Button>
      </div>
    </form>
  );
}
