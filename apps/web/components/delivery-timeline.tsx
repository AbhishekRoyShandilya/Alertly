import type { DeliveryWithAttempts } from '@alertly/shared';
import { dateTime, relativeTime } from '@/lib/format';
import { ChannelTag, StatusBadge } from './badges';
import { Button, Card, cx } from './ui';

const OUTCOME_DOT: Record<string, string> = {
  success: 'bg-emerald-500',
  retryable_error: 'bg-amber-500',
  permanent_error: 'bg-red-500',
};

/**
 * Per channel: every attempt with time, outcome, HTTP status, duration and error, then the
 * next scheduled retry if there is one. This is the "full delivery log" the product promises.
 */
export function DeliveryTimeline({
  deliveries,
  onRetry,
  retrying,
}: {
  deliveries: DeliveryWithAttempts[];
  onRetry?: (id: string) => void;
  retrying?: string;
}) {
  return (
    <div className="space-y-4">
      {deliveries.map((d) => (
        <Card key={d.id}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-3">
              <ChannelTag type={d.channelType} name={d.channelName} />
              <StatusBadge status={d.status} />
            </div>
            <div className="flex items-center gap-3 text-xs text-slate-500">
              <span>
                attempt {d.attemptCount}/{d.maxAttempts}
              </span>
              {onRetry && (d.status === 'failed' || d.status === 'dead') && (
                <Button
                  size="sm"
                  variant="secondary"
                  loading={retrying === d.id}
                  onClick={() => onRetry(d.id)}
                >
                  Retry
                </Button>
              )}
            </div>
          </div>

          <ol
            className="mt-4 space-y-3 border-l border-slate-200 pl-4 dark:border-slate-700"
            aria-label="Attempts"
          >
            {d.attempts.length === 0 && (
              <li className="text-sm text-slate-500">No attempts yet.</li>
            )}
            {d.attempts.map((a) => (
              <li key={a.attemptNo} className="relative text-sm">
                <span
                  aria-hidden
                  className={cx(
                    'absolute top-1.5 -left-[21px] size-2.5 rounded-full',
                    OUTCOME_DOT[a.outcome],
                  )}
                />
                <div className="flex flex-wrap gap-x-3">
                  <span className="font-medium">Attempt {a.attemptNo}</span>
                  <span className="text-slate-500">{dateTime(a.startedAt)}</span>
                  <span className="text-slate-500">{a.durationMs} ms</span>
                  {a.httpStatus !== null && (
                    <span className="font-mono text-xs">HTTP {a.httpStatus}</span>
                  )}
                  <span>{a.outcome.replace('_', ' ')}</span>
                </div>
                {a.error && (
                  <p className="mt-0.5 font-mono text-xs break-all text-red-600">{a.error}</p>
                )}
              </li>
            ))}
            {d.nextAttemptAt && (d.status === 'retrying' || d.status === 'pending') && (
              <li className="text-sm text-amber-700 dark:text-amber-400">
                Next attempt {relativeTime(d.nextAttemptAt)}
              </li>
            )}
          </ol>
        </Card>
      ))}
    </div>
  );
}
