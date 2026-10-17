import type { PriceProviderName, PriceResponse } from '@alertly/shared';
import type { Deps } from '../../context';
import { exec, query, queryOne } from '../../db/pool';
import { notFound } from '../../lib/errors';
import { defaultProviders, type ProviderRegistry } from './providers';

const CACHE_MS = 10_000;

interface SnapshotRow {
  price: number;
  observed_at: Date;
}

/**
 * Only the scheduler calls providers (`getLatest`), and it records every price in
 * price_snapshots. The API reads snapshots instead of calling providers itself, so:
 * - 100 rules on BTC, plus every dashboard viewer, cost one provider call per tick
 * - all processes see the same prices (each process's simulated walk would differ otherwise)
 */
export function createPriceService(
  { db, clock, log }: Deps,
  providers: ProviderRegistry = defaultProviders(),
) {
  const cache = new Map<string, { at: number; prices: Record<string, number> }>();

  return {
    providers,

    /** One provider call for many symbols, cached for 10 s, written to price_snapshots. */
    async getLatest(
      provider: PriceProviderName,
      symbols: string[],
    ): Promise<Record<string, number>> {
      const key = `${provider}:${[...symbols].sort().join(',')}`;
      const now = clock.now();
      const hit = cache.get(key);
      if (hit && now.getTime() - hit.at < CACHE_MS) return hit.prices;

      const prices = await providers[provider].getPrices(symbols);
      cache.set(key, { at: now.getTime(), prices });
      const rows = Object.entries(prices).map(([symbol, price]) => [provider, symbol, price, now]);
      if (rows.length > 0) {
        await exec(
          db,
          'INSERT INTO price_snapshots (provider, symbol, price, observed_at) VALUES ?',
          [rows],
        );
      }
      return prices;
    },

    /** The last recorded price at or before `at`. Used for pct_move ("price 60 minutes ago"). */
    async priceAt(provider: PriceProviderName, symbol: string, at: Date): Promise<number | null> {
      const row = await queryOne<SnapshotRow>(
        db,
        `SELECT price FROM price_snapshots
          WHERE provider = ? AND symbol = ? AND observed_at <= ?
          ORDER BY observed_at DESC LIMIT 1`,
        [provider, symbol, at],
      );
      return row?.price ?? null;
    },

    async latestSnapshot(provider: PriceProviderName, symbol: string) {
      return queryOne<SnapshotRow>(
        db,
        `SELECT price, observed_at FROM price_snapshots
          WHERE provider = ? AND symbol = ? ORDER BY observed_at DESC LIMIT 1`,
        [provider, symbol],
      );
    },

    /** Latest price + last 24 h, averaged into 5-minute buckets (~288 points) for a sparkline. */
    async getWithHistory(provider: PriceProviderName, symbol: string): Promise<PriceResponse> {
      const latest = await this.latestSnapshot(provider, symbol);
      if (!latest) throw notFound(`Price for ${symbol} (${provider})`);
      const since = new Date(clock.now().getTime() - 24 * 3600_000);
      const history = await query<{ bucket: number; price: number }>(
        db,
        `SELECT FLOOR(UNIX_TIMESTAMP(observed_at) / 300) AS bucket, AVG(price) AS price
           FROM price_snapshots
          WHERE provider = ? AND symbol = ? AND observed_at >= ?
          GROUP BY bucket ORDER BY bucket`,
        [provider, symbol, since],
      );
      return {
        symbol,
        provider,
        price: latest.price,
        observedAt: latest.observed_at.toISOString(),
        history: history.map((h) => ({
          price: Number(h.price),
          observedAt: new Date(Number(h.bucket) * 300_000).toISOString(),
        })),
      };
    },

    /** Keep 7 days. Deleted in chunks so one huge DELETE doesn't hold locks for long. */
    async pruneOld(days = 7): Promise<number> {
      const cutoff = new Date(clock.now().getTime() - days * 86_400_000);
      let total = 0;
      for (;;) {
        const r = await exec(db, 'DELETE FROM price_snapshots WHERE observed_at < ? LIMIT 5000', [
          cutoff,
        ]);
        total += r.affectedRows;
        if (r.affectedRows < 5000) break;
      }
      if (total > 0) log.info({ deleted: total }, 'pruned old price snapshots');
      return total;
    },
  };
}
export type PriceService = ReturnType<typeof createPriceService>;
