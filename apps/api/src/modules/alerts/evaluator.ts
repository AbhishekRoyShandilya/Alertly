import type { AlertState, ConditionType } from '@alertly/shared';

export interface RuleState {
  symbol: string;
  conditionType: ConditionType;
  threshold: number;
  windowMinutes: number | null;
  cooldownMinutes: number;
  state: AlertState;
  lastPrice: number | null;
  lastTriggeredAt: Date | null;
}

export interface EvalResult {
  fire: boolean;
  nextState: AlertState;
  reason: string;
}

const fmt = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 8 });

/** Percentage change from `ref` to `price`, e.g. 100 → 105 = 5. */
export const pctChange = (price: number, ref: number) => (price / ref - 1) * 100;

/**
 * "Is the condition true right now?" (a level). Used to decide when a fired rule has RESET.
 * For crosses, the level is which side of the threshold the price is on.
 */
function isActive(r: RuleState, price: number, refPrice: number | null): boolean {
  switch (r.conditionType) {
    case 'above':
    case 'cross_above':
      return price > r.threshold;
    case 'below':
    case 'cross_below':
      return price < r.threshold;
    case 'pct_move':
      return (
        refPrice !== null && refPrice > 0 && Math.abs(pctChange(price, refPrice)) >= r.threshold
      );
  }
}

/** "Should an ARMED rule fire now?" Crosses need the previous price to have been on the other side. */
function shouldFire(r: RuleState, price: number, refPrice: number | null): boolean {
  switch (r.conditionType) {
    case 'cross_above':
      return r.lastPrice !== null && r.lastPrice <= r.threshold && price > r.threshold;
    case 'cross_below':
      return r.lastPrice !== null && r.lastPrice >= r.threshold && price < r.threshold;
    default:
      return isActive(r, price, refPrice);
  }
}

function describe(r: RuleState, price: number, refPrice: number | null): string {
  const p = `${r.symbol} ${fmt(price)}`;
  switch (r.conditionType) {
    case 'above':
      return `${p} is above ${fmt(r.threshold)}`;
    case 'below':
      return `${p} is below ${fmt(r.threshold)}`;
    case 'cross_above':
      return `${p} crossed above ${fmt(r.threshold)} (was ${fmt(r.lastPrice ?? 0)})`;
    case 'cross_below':
      return `${p} crossed below ${fmt(r.threshold)} (was ${fmt(r.lastPrice ?? 0)})`;
    case 'pct_move': {
      const change = refPrice ? pctChange(price, refPrice) : 0;
      return `${p} moved ${change >= 0 ? '+' : ''}${change.toFixed(2)}% in ${r.windowMinutes} min`;
    }
  }
}

/**
 * The alert state machine. Pure: no I/O, the caller supplies the price, the time and (for
 * pct_move) the reference price `windowMinutes` ago.
 *
 *   armed ──condition met──▶ triggered      (fire: notify ONCE)
 *   triggered ──condition still true──▶ triggered   (no spam while BTC stays above 70k)
 *   triggered ──condition reset──▶ armed, or cooldown if the cooldown hasn't passed yet
 *   cooldown ──cooldown passed──▶ armed
 *
 * Requiring the condition to RESET before re-arming is hysteresis: a price hovering around
 * the threshold doesn't produce a notification every 15 seconds.
 */
export function evaluate(
  r: RuleState,
  price: number,
  now: Date,
  refPrice: number | null = null,
): EvalResult {
  const cooldownEnds = r.lastTriggeredAt
    ? new Date(r.lastTriggeredAt.getTime() + r.cooldownMinutes * 60_000)
    : null;
  const cooldownOver = !cooldownEnds || now >= cooldownEnds;

  switch (r.state) {
    case 'armed': {
      if (shouldFire(r, price, refPrice)) {
        return { fire: true, nextState: 'triggered', reason: describe(r, price, refPrice) };
      }
      if (r.conditionType === 'pct_move' && refPrice === null) {
        return {
          fire: false,
          nextState: 'armed',
          reason: `Not enough price history yet for a ${r.windowMinutes} min window`,
        };
      }
      if (
        (r.conditionType === 'cross_above' || r.conditionType === 'cross_below') &&
        r.lastPrice === null
      ) {
        return {
          fire: false,
          nextState: 'armed',
          reason: 'First price recorded; a cross needs a previous price',
        };
      }
      return {
        fire: false,
        nextState: 'armed',
        reason: `Condition not met (${r.symbol} ${fmt(price)})`,
      };
    }
    case 'triggered': {
      if (isActive(r, price, refPrice)) {
        return {
          fire: false,
          nextState: 'triggered',
          reason: 'Condition still true; waiting for it to reset',
        };
      }
      return cooldownOver
        ? { fire: false, nextState: 'armed', reason: 'Condition reset; re-armed' }
        : {
            fire: false,
            nextState: 'cooldown',
            reason: `Condition reset; cooling down until ${cooldownEnds!.toISOString()}`,
          };
    }
    case 'cooldown':
      return cooldownOver
        ? { fire: false, nextState: 'armed', reason: 'Cooldown over; re-armed' }
        : {
            fire: false,
            nextState: 'cooldown',
            reason: `Cooling down until ${cooldownEnds!.toISOString()}`,
          };
  }
}
