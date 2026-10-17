'use client';

import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  CONDITION_TYPES,
  CreateAlertInput,
  PRICE_PROVIDERS,
  SUPPORTED_SYMBOLS,
  type Channel,
} from '@alertly/shared';
import { CONDITION_LABEL } from '@/lib/format';
import { Button, Field, Input, Select } from './ui';

/**
 * Create-alert form. Validation uses the SAME Zod schema as the API (from packages/shared), so
 * the browser shows exactly the errors the server would return, without a round trip.
 * The "window" field only appears for pct_move.
 */
export function AlertForm({
  channels,
  onSubmit,
  submitting,
}: {
  channels: Channel[];
  onSubmit: (input: CreateAlertInput) => void;
  submitting?: boolean;
}) {
  const {
    register,
    handleSubmit,
    control,
    formState: { errors },
  } = useForm({
    resolver: zodResolver(CreateAlertInput),
    defaultValues: {
      name: '',
      symbol: 'BTCUSDT' as const,
      provider: 'simulated' as const,
      conditionType: 'cross_above' as const,
      cooldownMinutes: 60,
      channelIds: channels[0] ? [channels[0].id] : [],
    },
  });
  const condition = useWatch({ control, name: 'conditionType' });
  const isPct = condition === 'pct_move';

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="grid gap-4 sm:grid-cols-2" noValidate>
      <div className="sm:col-span-2">
        <Field label="Name" htmlFor="name" error={errors.name?.message}>
          <Input id="name" placeholder="BTC crosses 70k" {...register('name')} />
        </Field>
      </div>
      <Field label="Symbol" htmlFor="symbol">
        <Select id="symbol" {...register('symbol')}>
          {SUPPORTED_SYMBOLS.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </Select>
      </Field>
      <Field
        label="Price source"
        htmlFor="provider"
        hint="Simulated works everywhere and moves fast"
      >
        <Select id="provider" {...register('provider')}>
          {PRICE_PROVIDERS.map((p) => (
            <option key={p}>{p}</option>
          ))}
        </Select>
      </Field>
      <Field label="Condition" htmlFor="conditionType">
        <Select id="conditionType" {...register('conditionType')}>
          {CONDITION_TYPES.map((c) => (
            <option key={c} value={c}>
              {CONDITION_LABEL[c]}
            </option>
          ))}
        </Select>
      </Field>
      <Field
        label={isPct ? 'Threshold (%)' : 'Threshold (price)'}
        htmlFor="threshold"
        error={errors.threshold?.message}
      >
        <Input
          id="threshold"
          type="number"
          step="any"
          {...register('threshold', { valueAsNumber: true })}
        />
      </Field>
      {isPct && (
        <Field
          label="Window (minutes)"
          htmlFor="windowMinutes"
          error={errors.windowMinutes?.message}
        >
          <Input
            id="windowMinutes"
            type="number"
            {...register('windowMinutes', { valueAsNumber: true })}
          />
        </Field>
      )}
      <Field
        label="Cooldown (minutes)"
        htmlFor="cooldownMinutes"
        hint="Minimum time between two notifications"
        error={errors.cooldownMinutes?.message}
      >
        <Input
          id="cooldownMinutes"
          type="number"
          {...register('cooldownMinutes', { valueAsNumber: true })}
        />
      </Field>
      <fieldset className="sm:col-span-2">
        <legend className="text-sm font-medium text-slate-700 dark:text-slate-300">
          Notify these channels
        </legend>
        <div className="mt-2 flex flex-wrap gap-3">
          {channels.map((c) => (
            <label key={c.id} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                value={c.id}
                {...register('channelIds')}
                className="accent-brand-600"
              />
              {c.name} <span className="text-slate-400">({c.type})</span>
            </label>
          ))}
        </div>
        {errors.channelIds && (
          <p role="alert" className="mt-1 text-xs text-red-600">
            Choose at least one channel
          </p>
        )}
      </fieldset>
      <div className="sm:col-span-2">
        <Button type="submit" loading={submitting}>
          Create alert
        </Button>
      </div>
    </form>
  );
}
