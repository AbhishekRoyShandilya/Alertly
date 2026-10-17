import pLimit from 'p-limit';
import type { Deps } from '../context';
import type { SenderRegistry } from '../modules/channels/senders';
import type { SendResult } from '../modules/channels/senders/types';
import {
  claimDue,
  persistOutcome,
  recoverStuck,
  type ClaimedDelivery,
} from '../modules/deliveries/queue';
import { decide } from '../modules/deliveries/decide';

export interface WorkerOptions {
  workerId: string;
  batchSize: number;
  concurrency: number;
  idleDelayMs?: number; // poll interval when the queue was empty (backs off up to this)
  busyDelayMs?: number; // poll interval right after finding work
  stuckAfterSec?: number;
  recoverEveryMs?: number;
}

export interface BatchSummary {
  claimed: number;
  delivered: number;
  retried: number;
  failed: number;
  dead: number;
  lost: number; // results discarded because recoverStuck had reassigned the row
}

/**
 * The delivery worker. Runs as its own process (src/worker.ts). Several can run at once:
 * SKIP LOCKED gives each a disjoint batch.
 */
export class DeliveryWorker {
  private running = false;
  private loop?: Promise<void>;
  private wake?: () => void;
  private lastRecover = 0;

  constructor(
    private deps: Deps,
    private senders: SenderRegistry,
    private opts: WorkerOptions,
  ) {}

  /** Claims one batch and processes it completely. Tests call this directly. */
  async runOnce(): Promise<BatchSummary> {
    const { db, clock, log } = this.deps;
    const summary: BatchSummary = {
      claimed: 0,
      delivered: 0,
      retried: 0,
      failed: 0,
      dead: 0,
      lost: 0,
    };

    const nowMs = clock.now().getTime();
    if (nowMs - this.lastRecover >= (this.opts.recoverEveryMs ?? 60_000)) {
      this.lastRecover = nowMs;
      const recovered = await recoverStuck(db, clock.now(), this.opts.stuckAfterSec ?? 300);
      if (recovered > 0) log.warn({ recovered }, 'recovered stuck deliveries');
    }

    const batch = await claimDue(db, this.opts.workerId, this.opts.batchSize, clock.now());
    summary.claimed = batch.length;
    if (batch.length === 0) return summary;

    // At most `concurrency` sends in flight: protects external APIs and our DB pool.
    const limit = pLimit(this.opts.concurrency);
    await Promise.all(batch.map((d) => limit(() => this.processOne(d, summary))));

    log.info({ ...summary }, 'batch done');
    return summary;
  }

  private async processOne(d: ClaimedDelivery, summary: BatchSummary): Promise<void> {
    const { db, clock, log } = this.deps;
    const startedAt = clock.now();
    const t0 = Date.now();

    let result: SendResult;
    try {
      result = await this.senders[d.c_type].send({ delivery: d, attemptNo: d.total_attempts });
    } catch (err) {
      // Senders shouldn't throw; if one does, treat it as a temporary failure, not a crash.
      result = {
        ok: false,
        retryable: true,
        error: `Sender crashed: ${(err as Error).message}`,
        durationMs: Date.now() - t0,
      };
    }

    const now = clock.now();
    const decision = decide(d, result, now);
    const owned = await persistOutcome(
      db,
      d,
      this.opts.workerId,
      decision,
      {
        attemptNo: d.total_attempts,
        startedAt,
        finishedAt: now,
        durationMs: result.durationMs,
        outcome: result.ok ? 'success' : result.retryable ? 'retryable_error' : 'permanent_error',
        httpStatus: result.httpStatus ?? null,
        error: result.ok ? null : result.error,
      },
      now,
    );

    if (!owned) summary.lost++;
    else if (decision.kind === 'delivered') summary.delivered++;
    else if (decision.kind === 'retry') summary.retried++;
    else if (decision.kind === 'failed') summary.failed++;
    else summary.dead++;

    log.debug(
      {
        deliveryId: d.id,
        channel: d.c_type,
        attempt: d.total_attempts,
        decision: decision.kind,
        ms: result.durationMs,
      },
      'delivery attempt',
    );
  }

  /** Poll loop: fast while there is work, backing off to `idleDelayMs` when idle. */
  start(): void {
    if (this.running) return;
    this.running = true;
    const busy = this.opts.busyDelayMs ?? 100;
    const idle = this.opts.idleDelayMs ?? 5000;
    let delay = busy;

    this.loop = (async () => {
      while (this.running) {
        try {
          const s = await this.runOnce();
          delay = s.claimed > 0 ? busy : Math.min(idle, Math.max(1000, delay * 2));
        } catch (err) {
          this.deps.log.error({ err }, 'worker iteration failed');
          delay = idle; // e.g. DB down: don't spin
        }
        if (this.running) await this.sleep(delay);
      }
    })();
  }

  /**
   * Graceful stop: no new claims; the current batch finishes (its sends have their own
   * 10 s timeouts). If we got killed anyway, recoverStuck() re-queues the rows later.
   */
  async stop(): Promise<void> {
    this.running = false;
    this.wake?.();
    await this.loop;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      this.wake = () => {
        clearTimeout(t);
        resolve();
      };
    });
  }
}
