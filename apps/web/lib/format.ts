const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

/** "3 minutes ago", "in 2 hours". */
export function relativeTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '—';
  const diffSec = Math.round((new Date(iso).getTime() - now) / 1000);
  const abs = Math.abs(diffSec);
  if (abs < 45) return rtf.format(diffSec, 'second');
  if (abs < 2700) return rtf.format(Math.round(diffSec / 60), 'minute');
  if (abs < 64800) return rtf.format(Math.round(diffSec / 3600), 'hour');
  return rtf.format(Math.round(diffSec / 86400), 'day');
}

export const dateTime = (iso: string | null | undefined): string =>
  iso
    ? new Date(iso).toLocaleString('en-GB', {
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
    : '—';

/** Prices: more decimals for small numbers (DOGE 0.1234, BTC 68,012.50). */
export const price = (n: number | null | undefined): string =>
  n === null || n === undefined
    ? '—'
    : n.toLocaleString('en-US', { maximumFractionDigits: n < 1 ? 6 : n < 100 ? 4 : 2 });

export const percent = (r: number | null | undefined): string =>
  r === null || r === undefined ? '—' : `${(r * 100).toFixed(1)}%`;

export const CONDITION_LABEL: Record<string, string> = {
  above: 'is above',
  below: 'is below',
  cross_above: 'crosses above',
  cross_below: 'crosses below',
  pct_move: 'moves by',
};
