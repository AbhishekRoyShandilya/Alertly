import {
  DELIVERY_STATUSES,
  type Delivery,
  type DeliveryStats,
  type DeliveryWithAttempts,
  type Page,
} from '@alertly/shared';
import type { Deps } from '../../context';
import { conflict, notFound } from '../../lib/errors';
import { toPage } from '../../lib/pagination';
import { toDelivery, withAttempts } from './mappers';
import * as repo from './repo';

export function createDeliveriesService({ db, clock }: Deps) {
  async function get(userId: number, id: number): Promise<DeliveryWithAttempts> {
    const row = await repo.findDelivery(db, userId, id);
    if (!row) throw notFound('Delivery');
    const attempts = await repo.listAttemptsForDeliveries(db, [row.id]);
    return withAttempts([row], attempts)[0]!;
  }

  return {
    get,

    async list(
      userId: number,
      filters: repo.DeliveryFilters,
      limit: number,
      cursor?: string,
    ): Promise<Page<Delivery>> {
      const rows = await repo.listDeliveries(db, userId, filters, limit, cursor);
      return toPage(rows, limit, toDelivery);
    },

    /** Dashboard numbers: deliveries per status over the last `hours`, plus a success rate. */
    async stats(userId: number, hours: number): Promise<DeliveryStats> {
      const since = new Date(clock.now().getTime() - hours * 3600_000);
      const counts = Object.fromEntries(
        DELIVERY_STATUSES.map((s) => [s, 0]),
      ) as DeliveryStats['counts'];
      for (const row of await repo.countByStatus(db, userId, since)) counts[row.status] = row.n;
      const finished = counts.delivered + counts.failed + counts.dead;
      return {
        since: since.toISOString(),
        counts,
        successRate: finished === 0 ? null : counts.delivered / finished,
      };
    },

    /** Only failed or dead deliveries can be retried by hand. */
    async retryManually(userId: number, id: number): Promise<DeliveryWithAttempts> {
      const row = await repo.findDelivery(db, userId, id);
      if (!row) throw notFound('Delivery');
      const r = await repo.resetForManualRetry(db, id, clock.now());
      if (r.affectedRows === 0) {
        throw conflict(`Only failed or dead deliveries can be retried (this one is ${row.status})`);
      }
      return get(userId, id);
    },
  };
}
export type DeliveriesService = ReturnType<typeof createDeliveriesService>;
