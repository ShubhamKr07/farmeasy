import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { calcDaysOverdue, generateShortId, seedingWeight } from "./utils.js";

// ── calcDaysOverdue ───────────────────────────────────────────────────────────

describe("calcDaysOverdue", () => {
  // A single pinned reference instant for every boundary case below. The
  // function reads `now` from this argument instead of its own Date.now(), so
  // "exactly on the due date" is genuinely exact (no double-Date.now() race —
  // see the note on calcDaysOverdue itself).
  const NOW = Date.now();

  it("returns null when startedAt is null", () => {
    assert.strictEqual(calcDaysOverdue(null, 10, NOW), null);
  });

  it("returns null when due date is in the future", () => {
    const startedAt = new Date(NOW - 5 * 864e5); // 5 days ago
    assert.strictEqual(calcDaysOverdue(startedAt, 10, NOW), null); // due in 5 more days
  });

  it("returns null when exactly on the due date", () => {
    const startedAt = new Date(NOW - 10 * 864e5); // exactly 10 days ago → dueMs === NOW
    assert.strictEqual(calcDaysOverdue(startedAt, 10, NOW), null);
  });

  it("returns correct overdue days when past due", () => {
    const startedAt = new Date(NOW - 15 * 864e5); // 15 days ago, period=10 → 5 overdue
    const result = calcDaysOverdue(startedAt, 10, NOW);
    assert.strictEqual(result, 5);
  });

  it("returns 0 days overdue when 1s past due", () => {
    // just over due — floors to 0
    const startedAt = new Date(NOW - 10 * 864e5 - 1000);
    const result = calcDaysOverdue(startedAt, 10, NOW);
    assert.strictEqual(result, 0);
  });

  it("handles large overdue values correctly", () => {
    const startedAt = new Date(NOW - 100 * 864e5); // 100 days ago, period=10 → 90 overdue
    const result = calcDaysOverdue(startedAt, 10, NOW);
    assert.strictEqual(result, 90);
  });
});

// ── generateShortId ───────────────────────────────────────────────────────────

describe("generateShortId", () => {
  it("returns a 4-character hex string", () => {
    const id = generateShortId();
    assert.match(id, /^[0-9a-f]{4}$/, `expected 4-char hex, got '${id}'`);
  });

  it("is zero-padded to 4 chars", () => {
    // Run many times to hit small values
    for (let i = 0; i < 50; i++) {
      const id = generateShortId();
      assert.strictEqual(id.length, 4);
    }
  });

  it("produces different values across multiple calls", () => {
    const ids = new Set(Array.from({ length: 20 }, () => generateShortId()));
    assert.ok(ids.size > 1, "expected some variety in generated IDs");
  });
});

// ── seedingWeight ─────────────────────────────────────────────────────────────

describe("seedingWeight", () => {
  it("calculates full trays only", () => {
    assert.strictEqual(seedingWeight(10, 0, "5"), 50);
  });

  it("calculates half trays at 0.5 weight", () => {
    assert.strictEqual(seedingWeight(0, 10, "4"), 20);
  });

  it("combines full and half trays", () => {
    // 4 full + 4 half = 4 + 2 = 6 effective × 10 g = 60 g
    assert.strictEqual(seedingWeight(4, 4, "10"), 60);
  });

  it("returns 0 when seedWeightTray is null", () => {
    assert.strictEqual(seedingWeight(10, 10, null), 0);
  });

  it("returns 0 when no trays", () => {
    assert.strictEqual(seedingWeight(0, 0, "10"), 0);
  });

  it("handles fractional seed weight", () => {
    assert.strictEqual(seedingWeight(2, 0, "2.5"), 5);
  });
});
