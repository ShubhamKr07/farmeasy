/** Pure utility functions — no DB or HTTP dependencies, fully unit-testable. */

// `now` is injectable (defaults to Date.now()) so callers pass it through
// unchanged, while tests can pin a single reference instant. Without this, a
// boundary test that builds `startedAt` from its OWN Date.now() and then lets
// this function read a SECOND Date.now() races on the sub-millisecond gap
// between the two reads — "exactly on the due date" is then almost always a
// hair past due (returns 0, not null) except when both reads land in the same
// millisecond, which is why that test passed on fast machines but flaked in CI.
export function calcDaysOverdue(
  startedAt: Date | null,
  days: number,
  now: number = Date.now(),
): number | null {
  if (!startedAt) return null;
  const dueMs = startedAt.getTime() + days * 864e5;
  if (now <= dueMs) return null;
  return Math.floor((now - dueMs) / 864e5);
}

export function generateShortId(): string {
  return Math.floor(Math.random() * 0xffff)
    .toString(16)
    .padStart(4, "0");
}

export function seedingWeight(
  fullTrays: number,
  halfTrays: number,
  seedWeightTray: string | null,
): number {
  return Number(seedWeightTray ?? 0) * (fullTrays + halfTrays * 0.5);
}
