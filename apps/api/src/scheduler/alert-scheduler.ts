import { SUPPORTED_SYMBOLS, type PriceProviderName } from '@alertly/shared';
import type { Deps } from '../context';
import type { Conn } from '../db/pool';
import { listActiveRules, type AlertRuleRow } from '../modules/alerts/repo';
import { toRuleState, type AlertsService } from '../modules/alerts/service';
import { evaluate } from '../modules/alerts/evaluator';
import type { PriceService } from '../modules/prices/service';

// GET_LOCK names are global to the whole MySQL server, not per database, so the name includes
// the database: a dev and a staging scheduler sharing one server must not block each other.
const LOCK_SQL = "CONCAT('alertly_scheduler:', DATABASE())";

export interface TickSummary {
  skipped?: 'not_leader';
  rules: number;
  fired: number;
  errors: number;
}

/**
 * Every tick: load active rules â†’ one price call per provider â†’ evaluate each rule â†’ save.
 *
 * Only ONE scheduler may run, or two instances would both evaluate (and fire) every rule.
 * Leader election with a MySQL advisory lock: GET_LOCK('alertly_scheduler', 0) returns 1 for
 * exactly one connection. The lock belongs to that connection, so we keep one dedicated
 * connection open for the process lifetime (NOT a pooled one: a pool would hand the
 * connection to other queries and the lock would follow it around). If the leader dies, its
 * connection closes, MySQL releases the lock, and a standby takes over on its next tick.
 */
export class AlertScheduler {
  private lockConn?: Conn;
  private isLeader = false;
  private lastPrune = 0;
  private timer?: NodeJS.Timeout;
  private running?: Promise<unknown>;

  constructor(
    private deps: Deps,
    private alerts: AlertsService,
    private prices: PriceService,
  ) {}

  private async ensureLeader(): Promise<boolean> {
    if (this.isLeader && this.lockConn) {
      try {
        await this.lockConn.query('SELECT 1'); // still connected â†’ still holding the lock
        return true;
      } catch {
        this.isLeader = false;
        this.lockConn = undefined;
      }
    }
    try {
      this.lockConn ??= await this.deps.db.getConnection();
      const [rows] = await this.lockConn.query(`SELECT GET_LOCK(${LOCK_SQL}, 0) AS ok`);
      this.isLeader = (rows as { ok: number | null }[])[0]?.ok === 1;
    } catch (err) {
      this.deps.log.warn({ err }, 'leader election failed');
      this.lockConn?.release();
      this.lockConn = undefined;
      this.isLeader = false;
    }
    return this.isLeader;
  }

  async tick(): Promise<TickSummary> {
    const { db, clock, env, log } = this.deps;
    if (!(await this.ensureLeader()))
      return { skipped: 'not_leader', rules: 0, fired: 0, errors: 0 };

    const rules = await listActiveRules(db);
    const summary: TickSummary = { rules: rules.length, fired: 0, errors: 0 };

    // Group symbols by provider. The default provider always fetches every supported symbol,
    // so the dashboard's price sparklines have data even before any rule exists.
    const wanted = new Map<PriceProviderName, Set<string>>();
    wanted.set(env.PRICE_PROVIDER_DEFAULT, new Set(SUPPORTED_SYMBOLS));
    for (const r of rules) {
      if (!wanted.has(r.provider)) wanted.set(r.provider, new Set());
      wanted.get(r.provider)!.add(r.symbol);
    }

    const prices = new Map<PriceProviderName, Record<string, number>>();
    for (const [provider, symbols] of wanted) {
      try {
        prices.set(provider, await this.prices.getLatest(provider, [...symbols]));
      } catch (err) {
        // One provider down must not stop rules on the other providers.
        log.warn({ provider, err: (err as Error).message }, 'price fetch failed');
        summary.errors++;
      }
    }

    for (const rule of rules) {
      const price = prices.get(rule.provider)?.[rule.symbol];
      if (price === undefined) continue;
      try {
        if (await this.evaluateOne(rule, price)) summary.fired++;
      } catch (err) {
        log.error({ ruleId: rule.id, err }, 'rule evaluation failed');
        summary.errors++;
      }
    }

    const now = clock.now().getTime();
    if (now - this.lastPrune >= 3600_000) {
      this.lastPrune = now;
      await this.prices.pruneOld(7).catch((err: unknown) => log.warn({ err }, 'prune failed'));
    }
    if (summary.fired > 0 || summary.errors > 0) log.info({ ...summary }, 'tick');
    return summary;
  }

  private async evaluateOne(rule: AlertRuleRow, price: number): Promise<boolean> {
    const now = this.deps.clock.now();
    const ref = await this.alerts.refPriceFor(rule, now);
    const result = evaluate(toRuleState(rule), price, now, ref);
    await this.alerts.applyEvaluation(rule, result, price);
    return result.fire;
  }

  /** Runs tick() every intervalSec. Ticks never overlap: the next is scheduled after one ends. */
  start(intervalSec: number): void {
    const loop = async () => {
      this.running = this.tick().catch((err: unknown) =>
        this.deps.log.error({ err }, 'tick failed'),
      );
      await this.running;
      this.timer = setTimeout(loop, intervalSec * 1000);
    };
    void loop();
  }

  async stop(): Promise<void> {
    clearTimeout(this.timer);
    await this.running;
    if (this.lockConn) {
      await this.lockConn.query(`SELECT RELEASE_LOCK(${LOCK_SQL})`).catch(() => undefined);
      this.lockConn.release();
      this.lockConn = undefined;
    }
    this.isLeader = false;
  }
}
