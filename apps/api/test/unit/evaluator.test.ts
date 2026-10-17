import { describe, expect, it } from 'vitest';
import { evaluate, type RuleState } from '../../src/modules/alerts/evaluator';

const t0 = new Date('2026-10-16T09:00:00Z');
const at = (min: number) => new Date(t0.getTime() + min * 60_000);

const rule = (over: Partial<RuleState> = {}): RuleState => ({
  symbol: 'BTCUSDT',
  conditionType: 'above',
  threshold: 70_000,
  windowMinutes: null,
  cooldownMinutes: 60,
  state: 'armed',
  lastPrice: null,
  lastTriggeredAt: null,
  ...over,
});

describe('above / below', () => {
  it('fires once when armed and the condition is met', () => {
    const r = evaluate(rule(), 70_100, t0);
    expect(r).toMatchObject({ fire: true, nextState: 'triggered' });
    expect(r.reason).toContain('above 70,000');
    expect(evaluate(rule(), 69_900, t0)).toMatchObject({ fire: false, nextState: 'armed' });
  });

  it('does not fire again while the price stays above (no spam)', () => {
    const triggered = rule({ state: 'triggered', lastTriggeredAt: t0 });
    for (const min of [1, 30, 120, 600]) {
      expect(evaluate(triggered, 71_000, at(min))).toMatchObject({
        fire: false,
        nextState: 'triggered',
      });
    }
  });

  it('after a reset, waits for the cooldown before re-arming (hysteresis)', () => {
    const triggered = rule({ state: 'triggered', lastTriggeredAt: t0 });
    // price drops back below 10 minutes later: cooldown (60 min) not over
    const r1 = evaluate(triggered, 69_000, at(10));
    expect(r1).toMatchObject({ fire: false, nextState: 'cooldown' });
    // still cooling down at 59 min, even if the price is above again
    expect(
      evaluate(rule({ state: 'cooldown', lastTriggeredAt: t0 }), 71_000, at(59)).nextState,
    ).toBe('cooldown');
    // re-armed at 60 min
    expect(
      evaluate(rule({ state: 'cooldown', lastTriggeredAt: t0 }), 69_000, at(60)).nextState,
    ).toBe('armed');
  });

  it('re-arms immediately on reset if the cooldown already passed', () => {
    const r = evaluate(rule({ state: 'triggered', lastTriggeredAt: t0 }), 69_000, at(90));
    expect(r).toMatchObject({ fire: false, nextState: 'armed' });
  });

  it('full cycle: fire → stay → reset → cooldown → re-arm → fire again', () => {
    let s = rule({ cooldownMinutes: 30 });
    const step = (price: number, min: number) => {
      const r = evaluate(s, price, at(min));
      s = {
        ...s,
        state: r.nextState,
        lastPrice: price,
        lastTriggeredAt: r.fire ? at(min) : s.lastTriggeredAt,
      };
      return r.fire;
    };
    const fires = [
      step(70_500, 0), // fire
      step(71_000, 1), // still above
      step(69_000, 5), // reset → cooldown
      step(70_500, 10), // above again but cooling down
      step(69_500, 31), // cooldown over → armed
      step(70_200, 32), // fire again
    ];
    expect(fires).toEqual([true, false, false, false, false, true]);
  });

  it('below is the mirror image', () => {
    const r = rule({ conditionType: 'below', threshold: 60_000 });
    expect(evaluate(r, 59_000, t0).fire).toBe(true);
    expect(evaluate(r, 61_000, t0).fire).toBe(false);
  });
});

describe('cross_above / cross_below', () => {
  const cross = rule({ conditionType: 'cross_above' });

  it('the first evaluation only records the price', () => {
    const r = evaluate(cross, 71_000, t0);
    expect(r.fire).toBe(false);
    expect(r.reason).toMatch(/previous price/);
  });

  it('fires only when the previous price was at or below and the new one is above', () => {
    expect(evaluate({ ...cross, lastPrice: 69_999 }, 70_001, t0).fire).toBe(true);
    expect(evaluate({ ...cross, lastPrice: 70_000 }, 70_001, t0).fire).toBe(true);
    expect(evaluate({ ...cross, lastPrice: 70_500 }, 71_000, t0).fire).toBe(false); // already above
    expect(evaluate({ ...cross, lastPrice: 69_000 }, 69_500, t0).fire).toBe(false); // still below
  });

  it('cross_below mirrors it', () => {
    const r = rule({ conditionType: 'cross_below', threshold: 60_000, lastPrice: 60_100 });
    expect(evaluate(r, 59_900, t0).fire).toBe(true);
  });
});

describe('pct_move', () => {
  const pct = rule({ conditionType: 'pct_move', threshold: 5, windowMinutes: 60 });

  it('fires on a move of at least threshold % in either direction', () => {
    expect(evaluate(pct, 105, t0, 100)).toMatchObject({ fire: true });
    expect(evaluate(pct, 95, t0, 100)).toMatchObject({ fire: true });
    expect(evaluate(pct, 104.9, t0, 100).fire).toBe(false);
    expect(evaluate(pct, 105, t0, 100).reason).toContain('+5.00% in 60 min');
  });

  it('waits when there is no price history for the window yet', () => {
    const r = evaluate(pct, 200, t0, null);
    expect(r.fire).toBe(false);
    expect(r.reason).toMatch(/Not enough price history/);
  });
});
