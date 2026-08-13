import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { DraggableMetricGrid } from "@/components/metrics/DraggableMetricGrid";
import { getMetricDef } from "@workspace/metrics";

/**
 * OVW-001/002 — Overview grid height-contract regression suite.
 *
 * The contract (see DraggableMetricGrid.tsx's file-level doc): every card in
 * a rendered row stretches to that row's tallest member, so a row never shows
 * a short KPI card beside a tall chart card with dead space under the KPI.
 * It is implemented with three CSS primitives — NO fixed pixel heights
 * (scripts/ci/check-metric-heights.mjs bans `h-[…px]` from this directory):
 *
 *   - `grid-auto-rows: min-content`  — each implicit row sizes to its content.
 *   - `align-items: stretch`         — the grid default; every item fills the
 *                                       full row height set by the tallest item.
 *   - `h-full` on each card wrapper  — propagates that stretched height down
 *                                       into the rendered Card body.
 *
 * jsdom doesn't run a layout engine, so we assert the DECLARED contract — the
 * presence of the classes that produce the stretching — not computed pixels.
 * If any of those three primitives is dropped (e.g. a refactor removes
 * `h-full` from card wrappers, or swaps `grid-auto-rows: min-content` for a
 * fixed height), the corresponding assertion fails. That is exactly the
 * regression the CI pixel-height ban is meant to prevent from sneaking back.
 *
 * The suite also guards OVW-001's `size` token: the Total Yield (Week) card
 * carries `size: "tall"` in the registry (registry-overview.ts) — the intent
 * signal that a row containing it grows to fit chart-height content — and
 * that must survive any reorder.
 */

/**
 * Renders the grid with a `renderItem` that stamps each card with a
 * `data-card-id`, so tests can find individual cards and assert on their
 * wrapper's class set.
 */
function renderGrid(ids: string[], onReorder = vi.fn()) {
  render(
    <DraggableMetricGrid
      ids={ids}
      onReorder={onReorder}
      renderItem={(id) => (
        <div data-card-id={id} data-testid={`card-${id}`}>
          {getMetricDef(id)?.label ?? id}
        </div>
      )}
    />,
  );
}

/** The grid container is the outer <div> the component renders. */
function gridContainer(): HTMLElement {
  return document.querySelector(".grid.grid-cols-1") as HTMLElement;
}

/** Every card wrapper is the draggable direct child of the grid container. */
function cardWrappers(): HTMLElement[] {
  return Array.from(gridContainer().children) as HTMLElement[];
}

/** Find a wrapper by its descendant card's data-card-id. */
function findWrapperByCardId(id: string): HTMLElement | undefined {
  return cardWrappers().find((w) => w.querySelector(`[data-card-id="${id}"]`));
}

describe("DraggableMetricGrid — OVW-001/002 height contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("declares the row-height contract on the grid container (grid-auto-rows: min-content + items-stretch)", () => {
    renderGrid(["ov.yield.week", "ov.cycles.active"]);
    const grid = gridContainer();
    // grid-auto-rows: min-content — each implicit row sizes to its content.
    expect(grid.className).toContain("[grid-auto-rows:min-content]");
    // align-items: stretch — the grid default, made explicit so a row's cards
    // fill the full row height set by the tallest member.
    expect(grid.className).toContain("items-stretch");
  });

  it("every rendered card wrapper stretches to its row (h-full on each wrapper)", () => {
    // A mixed row: a tall chart (ov.yield.byWeek, span 2) + compact KPIs.
    renderGrid([
      "ov.yield.byWeek",
      "ov.cycles.active",
      "ov.cap.utilization",
      "ov.bad.count7d",
    ]);
    const wrappers = cardWrappers();
    expect(wrappers.length).toBe(4);
    // h-full propagates the grid's stretched row height down into the card
    // body — dropping it on any wrapper breaks the contract for that card.
    for (const wrapper of wrappers) {
      expect(wrapper.className).toContain("h-full");
    }
  });

  it("the Total Yield (Week) card renders with the 'tall' size class from the registry", () => {
    // OVW-001: the `size` token is the intent signal that a row containing a
    // tall chart grows to fit chart-height content. registry-overview.ts
    // stamps `size: "tall"` on ov.yield.week; this asserts the registry
    // contract is intact.
    const def = getMetricDef("ov.yield.week");
    expect(def).toBeDefined();
    expect(def?.size).toBe("tall");

    // And the card actually renders in the grid. Render it beside another
    // card so it keeps its natural span.
    renderGrid(["ov.yield.week", "ov.cycles.active"]);
    const card = screen.getByTestId("card-ov.yield.week");
    expect(card).toBeInTheDocument();

    // Its wrapper carries h-full (the height contract).
    const wrapper = findWrapperByCardId("ov.yield.week");
    expect(wrapper).toBeDefined();
    expect(wrapper?.className).toContain("h-full");
  });

  it("a compact KPI row stays compact (no card claims a 'tall' size token)", () => {
    // A row of nothing but compact KPIs must all be size 'compact' (or
    // undefined, which defaults to compact) — none should be 'tall', or a
    // short KPI row would balloon to chart height for no reason.
    const ids = ["ov.cycles.active", "ov.cap.utilization", "ov.bad.count7d"];
    renderGrid(ids);
    for (const id of ids) {
      const def = getMetricDef(id);
      expect(def?.size ?? "compact").toBe("compact");
    }
    // Every wrapper still carries h-full (the contract holds regardless of
    // whether a row is compact or tall — a compact row just happens to be
    // short).
    for (const wrapper of cardWrappers()) {
      expect(wrapper.className).toContain("h-full");
    }
  });

  it("drag-reorder preserves the height contract on every card after cards are reordered", () => {
    // OVW-002: reordering must not drop h-full or the grid's row-height
    // primitives — a reordered row still needs its cards to stretch to the
    // row's tallest member. We drive a real HTML5 drag-and-drop reorder
    // (drag the first card over the second), let onReorder fire, then
    // re-render with the new order and re-assert the contract.
    const initial = ["ov.yield.byWeek", "ov.cycles.active", "ov.cap.utilization"];
    const onReorder = vi.fn();

    renderGrid(initial, onReorder);
    const wrappers = cardWrappers();
    const dragSource = wrappers[0]; // ov.yield.byWeek (tall chart)
    const dropTarget = wrappers[1]; // ov.cycles.active

    // Fire the HTML5 DnD sequence the component listens for. jsdom doesn't
    // run a real drag pipeline, so we synthesize the events by hand.
    fireEvent.dragStart(dragSource);
    fireEvent.dragOver(dropTarget);
    fireEvent.drop(dropTarget);
    fireEvent.dragEnd(dragSource);

    // The component swaps the dragged card into the target's position and
    // calls onReorder with the new order.
    expect(onReorder).toHaveBeenCalledTimes(1);
    const nextOrder = onReorder.mock.calls[0][0] as string[];
    expect(nextOrder).toEqual([
      "ov.cycles.active",
      "ov.yield.byWeek",
      "ov.cap.utilization",
    ]);

    // Re-render with the reordered list and assert the contract is intact.
    cleanup();
    renderGrid(nextOrder);

    // (a) Container primitives survive the reorder.
    const grid = gridContainer();
    expect(grid.className).toContain("[grid-auto-rows:min-content]");
    expect(grid.className).toContain("items-stretch");

    // (b) Every wrapper — now in the new order — still carries h-full.
    const reorderedWrappers = cardWrappers();
    expect(reorderedWrappers.length).toBe(nextOrder.length);
    for (const wrapper of reorderedWrappers) {
      expect(wrapper.className).toContain("h-full");
    }

    // (c) The Yield by Week card's tall span (lg:col-span-2) survives the move
    // to a new position — it's the second card now, not the first.
    const yieldWrapper = findWrapperByCardId("ov.yield.byWeek");
    expect(yieldWrapper).toBeDefined();
    expect(yieldWrapper?.className).toContain("h-full");
    expect(yieldWrapper?.className).toContain("lg:col-span-2");
  });

  it("a single selected metric stretches to fill the full row (no lone half-empty card)", () => {
    // computeStretchOverrides forces a lone card to span the full 4-col row
    // so a single selected metric doesn't leave 3 empty columns. Assert the
    // wrapper picks up the lg:col-span-4 stretch class.
    renderGrid(["ov.cycles.active"]);
    const wrapper = cardWrappers()[0];
    expect(wrapper.className).toContain("lg:col-span-4");
    // ...and the height contract still holds.
    expect(wrapper.className).toContain("h-full");
  });
});
