import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Channel } from '@alertly/shared';
import { AlertForm } from '@/components/alert-form';

const channels: Channel[] = [
  {
    id: 'ch_1',
    type: 'email',
    name: 'Ops inbox',
    config: { to: 'ops@example.com' },
    status: 'active',
    verifiedAt: null,
    createdAt: '2026-10-16T09:00:00.000Z',
    updatedAt: '2026-10-16T09:00:00.000Z',
  },
];

describe('AlertForm', () => {
  it('shows the window field only for pct_move', async () => {
    render(<AlertForm channels={channels} onSubmit={vi.fn()} />);
    expect(screen.queryByLabelText('Window (minutes)')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Threshold (price)')).toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText('Condition'), 'pct_move');
    expect(screen.getByLabelText('Window (minutes)')).toBeInTheDocument();
    expect(screen.getByLabelText('Threshold (%)')).toBeInTheDocument();
  });

  it('validates with the shared schema and submits typed values', async () => {
    const onSubmit = vi.fn();
    render(<AlertForm channels={channels} onSubmit={onSubmit} />);

    await userEvent.click(screen.getByRole('button', { name: 'Create alert' }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getAllByRole('alert').length).toBeGreaterThan(0);

    await userEvent.type(screen.getByLabelText('Name'), 'BTC crosses 70k');
    await userEvent.type(screen.getByLabelText('Threshold (price)'), '70000');
    await userEvent.click(screen.getByRole('button', { name: 'Create alert' }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0]![0]).toMatchObject({
      name: 'BTC crosses 70k',
      symbol: 'BTCUSDT',
      conditionType: 'cross_above',
      threshold: 70000,
      channelIds: ['ch_1'],
    });
  });
});
