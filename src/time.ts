export type Clock = {
  nowMs(): number;
  nowIso(): string;
};

export const systemClock: Clock = {
  nowMs: () => Date.now(),
  nowIso: () => new Date().toISOString()
};

export function monotonicDueAt(delayMs: number, clock: Clock = systemClock): number {
  return clock.nowMs() + Math.max(delayMs, 0);
}
