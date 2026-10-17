import type { Delivery, DeliveryWithAttempts, Page } from '@alertly/shared';
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
