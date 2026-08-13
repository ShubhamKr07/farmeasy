/**
 * Task 8 (INV-009/010): Generalize QR modal to InventoryItem + batch printing.
 *
 * These tests cover the pure helper functions that drive the QR label flow:
 *   - generateQRPayload: idempotent, deterministic payload per item (inv:{id}:{name})
 *   - generateItemCode:  zero-padded SUP-XXXX code
 *
 * They use node's built-in `assert` so they run without a dedicated test
 * runner dependency. Invoke directly with `node --import tsx ...` or via any
 * future vitest/jest harness that registers `.tsx`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { InventoryItem } from "@workspace/api-client-react";
import { generateQRPayload, generateItemCode } from "./qr-helpers";

function makeItem(overrides: Partial<InventoryItem> = {}): InventoryItem {
  return {
    id: 42,
    name: "Organic Tomato Seeds",
    brand: null,
    category: "Seeds",
    qrCode: null,
    currentQty: 10,
    maxQty: 100,
    unit: "kg",
    arrivalDate: "2024-05-01T00:00:00.000Z",
    createdAt: new Date("2024-05-01T00:00:00.000Z"),
    ...overrides,
  };
}

describe("generateQRPayload", () => {
  it("is idempotent — same item produces the same payload every call", () => {
    const item = makeItem();
    const first = generateQRPayload(item);
    const second = generateQRPayload(item);
    assert.equal(first, second);
  });

  it("uses the inv: prefix format (inv:{id}:{sanitizedName})", () => {
    const item = makeItem({ id: 7, name: "Basil Seeds!" });
    const payload = generateQRPayload(item);
    assert.ok(payload.startsWith("inv:"), `expected inv: prefix, got ${payload}`);
    // Non-alphanumeric chars are replaced with hyphens.
    assert.equal(payload, "inv:7:basil-seeds-");
  });

  it("encodes the numeric item id and lowercases the name", () => {
    const item = makeItem({ id: 123, name: "POTATO Mix" });
    assert.equal(generateQRPayload(item), "inv:123:potato-mix");
  });
});

describe("batch print isolation (INV-010)", () => {
  it("item payloads never collide with seed-lot QR codes", () => {
    // Seed-lot QRs are server-issued opaque strings; item payloads are
    // deterministically prefixed `inv:`. A selected inventory item must not
    // accidentally reuse a seed-lot's payload.
    const item = makeItem({ id: 42, name: "Fertilizer" });
    const itemPayload = generateQRPayload(item);
    const seedLotQr = "LOT-XYZ-2024-0007";
    assert.notEqual(itemPayload, seedLotQr);
    assert.ok(itemPayload.startsWith("inv:"));
    assert.ok(!seedLotQr.startsWith("inv:"));
  });

  it("batch printing does not mutate per-item payloads across selections", () => {
    const a = makeItem({ id: 1, name: "Seeds A" });
    const b = makeItem({ id: 2, name: "Seeds B" });
    const before = [generateQRPayload(a), generateQRPayload(b)];
    // Simulate building a batch map (as the Print Labels button does) and
    // re-derive payloads afterwards — they must be unchanged.
    const batch = new Map<number, string>();
    for (const it of [a, b]) batch.set(it.id, generateQRPayload(it));
    const after = [a, b].map((it) => batch.get(it.id)!);
    assert.deepEqual(before, after);
    assert.deepEqual(after, ["inv:1:seeds-a", "inv:2:seeds-b"]);
  });
});

describe("generateItemCode", () => {
  it("zero-pads the id to 4 digits with the SUP- prefix", () => {
    assert.equal(generateItemCode(1), "SUP-0001");
    assert.equal(generateItemCode(42), "SUP-0042");
    assert.equal(generateItemCode(9999), "SUP-9999");
  });
});
