import type { PriceProviderName, SupportedSymbol } from '@alertly/shared';

export interface PriceProvider {
  name: PriceProviderName;
  /** Latest price per symbol. Symbols the provider can't price are simply absent. */
  getPrices(symbols: string[]): Promise<Record<string, number>>;
}

// ---------- simulated ----------

const BASE_PRICES: Record<SupportedSymbol, number> = {
  BTCUSDT: 68_000,
  ETHUSDT: 2_500,
  SOLUSDT: 150,
  BNBUSDT: 600,
  XRPUSDT: 0.6,
  ADAUSDT: 0.45,
  DOGEUSDT: 0.12,
};

/** mulberry32: a tiny seeded PRNG. Same seed → same sequence → reproducible demos and tests. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A random walk per symbol: each call moves every price by up to ±`stepPct`%.
 * The default provider for the live demo: no API key, no rate limits, works everywhere,
 * and moves enough that demo alerts actually fire. `setPrice` lets tests force a cross.
 */
export class SimulatedProvider implements PriceProvider {
  readonly name = 'simulated' as const;
  private prices = new Map<string, number>();
  private random: () => number;

  constructor(
    seed = 42,
    private stepPct = 0.3,
  ) {
    this.random = mulberry32(seed);
  }

  setPrice(symbol: string, price: number): void {
    this.prices.set(symbol, price);
  }

  /** Stop the random walk for a symbol (tests use this to hold a price steady). */
  private frozen = new Set<string>();
  freeze(symbol: string, price?: number): void {
    if (price !== undefined) this.prices.set(symbol, price);
    this.frozen.add(symbol);
  }

  async getPrices(symbols: string[]): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const s of symbols) {
      const base = BASE_PRICES[s as SupportedSymbol];
      if (base === undefined && !this.prices.has(s)) continue;
      let p = this.prices.get(s) ?? base!;
      if (!this.frozen.has(s)) {
        p *= 1 + ((this.random() * 2 - 1) * this.stepPct) / 100;
        this.prices.set(s, p);
      }
      out[s] = Number(p.toPrecision(10));
    }
    return out;
  }
}

// ---------- real providers ----------

async function getJson(url: string, fetchImpl: typeof fetch): Promise<unknown> {
  // Timeout 5 s, one retry on failure (design 7.10).
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetchImpl(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (attempt >= 2) throw err;
    }
  }
}

const COINGECKO_IDS: Record<SupportedSymbol, string> = {
  BTCUSDT: 'bitcoin',
  ETHUSDT: 'ethereum',
  SOLUSDT: 'solana',
  BNBUSDT: 'binancecoin',
  XRPUSDT: 'ripple',
  ADAUSDT: 'cardano',
  DOGEUSDT: 'dogecoin',
};

/** CoinGecko public API: one request for all symbols, no key for basic use (USD ≈ USDT). */
export function coingeckoProvider(fetchImpl: typeof fetch = fetch): PriceProvider {
  return {
    name: 'coingecko',
    async getPrices(symbols) {
      const pairs = symbols
        .map((s) => [s, COINGECKO_IDS[s as SupportedSymbol]] as const)
        .filter(([, id]) => id);
      if (pairs.length === 0) return {};
      const ids = pairs.map(([, id]) => id).join(',');
      const data = (await getJson(
        `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`,
        fetchImpl,
      )) as Record<string, { usd?: number }>;
      const out: Record<string, number> = {};
      for (const [symbol, id] of pairs) {
        const usd = data[id!]?.usd;
        if (typeof usd === 'number') out[symbol] = usd;
      }
      return out;
    },
  };
}

/** Binance public ticker. Note: blocked from some regions (e.g. US IPs get HTTP 451). */
export function binanceProvider(fetchImpl: typeof fetch = fetch): PriceProvider {
  return {
    name: 'binance',
    async getPrices(symbols) {
      if (symbols.length === 0) return {};
      const q = encodeURIComponent(JSON.stringify(symbols));
      const data = (await getJson(
        `https://api.binance.com/api/v3/ticker/price?symbols=${q}`,
        fetchImpl,
      )) as { symbol: string; price: string }[];
      return Object.fromEntries(data.map((t) => [t.symbol, Number(t.price)]));
    },
  };
}

export type ProviderRegistry = Record<PriceProviderName, PriceProvider>;

export const defaultProviders = (): ProviderRegistry => ({
  simulated: new SimulatedProvider(Date.now() % 100_000),
  coingecko: coingeckoProvider(),
  binance: binanceProvider(),
});
