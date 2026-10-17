/**
 * All "what time is it?" questions go through a Clock. Production uses the system clock;
 * tests use a fake clock they can move forward, so retry and cooldown timing is testable
 * without real waiting. Queries receive the time as a parameter instead of using NOW().
 */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export class FakeClock implements Clock {
  private t: number;
  constructor(start: Date | string = '2026-10-16T09:00:00.000Z') {
    this.t = new Date(start).getTime();
  }
  now(): Date {
    return new Date(this.t);
  }
  set(d: Date | string): void {
    this.t = new Date(d).getTime();
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

export const MINUTE = 60_000;

/** "2026-10-16" for a Date, in UTC. Used for usage_daily rows. */
export const utcDay = (d: Date): string => d.toISOString().slice(0, 10);

export const toIso = (d: Date): string => d.toISOString();
export const toIsoOrNull = (d: Date | null): string | null => (d ? d.toISOString() : null);
