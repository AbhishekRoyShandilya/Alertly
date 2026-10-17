import type { AlertState, DeliveryStatus } from '@alertly/shared';
import { cx } from './ui';

const DELIVERY: Record<DeliveryStatus, string> = {
  pending: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  sending: 'bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300',
  retrying: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  delivered: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
  failed: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
  dead: 'bg-red-600 text-white',
};

export const StatusBadge = ({ status }: { status: DeliveryStatus }) => (
  <span
    className={cx('inline-flex rounded-full px-2 py-0.5 text-xs font-medium', DELIVERY[status])}
  >
    {status}
  </span>
);

const ALERT: Record<AlertState, string> = {
  armed: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
  triggered: 'bg-brand-100 text-brand-700 dark:bg-brand-700/30 dark:text-brand-100',
  cooldown: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
};

export const AlertStateBadge = ({
  state,
  active = true,
}: {
  state: AlertState;
  active?: boolean;
}) =>
  active ? (
    <span className={cx('inline-flex rounded-full px-2 py-0.5 text-xs font-medium', ALERT[state])}>
      {state}
    </span>
  ) : (
    <span className="inline-flex rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-500 dark:bg-slate-800">
      paused
    </span>
  );

const CHANNEL_ICON: Record<string, string> = { email: '✉', webhook: '⇄', telegram: '✈' };

export const ChannelTag = ({ type, name }: { type: string; name?: string }) => (
  <span className="inline-flex items-center gap-1.5 text-sm">
    <span aria-hidden className="text-slate-400">
      {CHANNEL_ICON[type] ?? '•'}
    </span>
    {name ?? type}
  </span>
);
