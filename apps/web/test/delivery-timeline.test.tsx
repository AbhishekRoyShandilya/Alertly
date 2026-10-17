import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DeliveryWithAttempts } from '@alertly/shared';
import { DeliveryTimeline } from '@/components/delivery-timeline';

const base: DeliveryWithAttempts = {
  id: 'dlv_1',
  notificationId: 'ntf_1',
  channelId: 'ch_1',
  channelName: 'Prod webhook',
  channelType: 'webhook',
  status: 'retrying',
  attemptCount: 2,
  maxAttempts: 6,
  nextAttemptAt: new Date(Date.now() + 120_000).toISOString(),
  lastError: 'HTTP 503',
  deliveredAt: null,
  createdAt: '2026-10-16T09:00:00.000Z',
  updatedAt: '2026-10-16T09:00:30.000Z',
  attempts: [
    {
      attemptNo: 1,
      startedAt: '2026-10-16T09:00:00.000Z',
      finishedAt: '2026-10-16T09:00:00.120Z',
      durationMs: 120,
      outcome: 'retryable_error',
      httpStatus: 500,
      error: 'HTTP 500',
    },
    {
      attemptNo: 2,
      startedAt: '2026-10-16T09:00:31.000Z',
      finishedAt: '2026-10-16T09:00:31.090Z',
      durationMs: 90,
      outcome: 'retryable_error',
      httpStatus: 503,
      error: 'HTTP 503',
    },
  ],
};

describe('DeliveryTimeline', () => {
  it('renders every attempt with status code, duration and error, plus the next retry', () => {
    render(<DeliveryTimeline deliveries={[base]} />);
    const list = screen.getByRole('list', { name: 'Attempts' });
    expect(within(list).getByText('Attempt 1')).toBeInTheDocument();
    expect(within(list).getByText('Attempt 2')).toBeInTheDocument();
    expect(within(list).getByText('HTTP 503', { selector: 'span' })).toBeInTheDocument();
    expect(within(list).getByText('120 ms')).toBeInTheDocument();
    expect(within(list).getByText(/Next attempt in 2 minutes/)).toBeInTheDocument();
    expect(screen.getByText('Prod webhook')).toBeInTheDocument();
    expect(screen.getByText('retrying')).toBeInTheDocument();
  });

  it('offers Retry only for failed or dead deliveries', async () => {
    const onRetry = vi.fn();
    const { rerender } = render(<DeliveryTimeline deliveries={[base]} onRetry={onRetry} />);
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();

    rerender(
      <DeliveryTimeline
        deliveries={[{ ...base, status: 'dead', nextAttemptAt: null }]}
        onRetry={onRetry}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledWith('dlv_1');
    expect(screen.queryByText(/Next attempt/)).not.toBeInTheDocument();
  });
});
