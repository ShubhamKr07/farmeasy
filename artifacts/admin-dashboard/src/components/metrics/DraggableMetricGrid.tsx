import React, { useMemo, useState } from "react";
import { GripVertical } from "lucide-react";
import { getMetricDef } from "@workspace/metrics";
import { cardSpan } from "./MetricGrid";

interface DraggableMetricGridProps {
  ids: string[];
  onReorder: (next: string[]) => void;
  renderItem: (id: string) => React.ReactNode;
}

const DESKTOP_COLS = 4;

/**
 * Overview grid height contract (OVW-001/002): every card in a rendered row
 * stretches to that row's tallest member, so a row never shows a short KPI
 * card beside a tall chart card with dead space under the KPI.
 *
 * Implemented with three CSS grid primitives — no fixed pixel heights
 * anywhere (a CI check, scripts/ci/check-metric-heights.mjs, bans
 * `h-[…px]` from this directory):
 *  - `grid-auto-rows: min-content` — each implicit row sizes to its content.
 *  - `align-items: stretch` (the grid default) — every item in a row fills
 *    the full row height set by the row's tallest content.
 *  - `h-full` on each card wrapper — propagates that stretched height down
 *    into the rendered Card so its body fills the row.
 *
 * The `size` token on each MetricDef ('compact' | 'tall', default 'compact')
 * is the *intent* signal: a row of compact KPIs stays short, a row
 * containing a tall chart grows to fit the chart. The grid does not need to
 * read `size` to do the stretching — it's declarative documentation consumed
 * by reviewers and future layout logic — but card bodies may use it to opt
 * into taller internal content (e.g. the Total Yield spark trend).
 */

/**
 * Static class lookup so Tailwind's JIT scanner can see every class literally
 * (template-interpolated classes like `md:col-span-${n}` are invisible to the
 * scanner and get purged).
 */
const SPAN_CLASS: Record<number, string> = {
  1: "md:col-span-1 lg:col-span-1",
  2: "md:col-span-2 lg:col-span-2",
  3: "md:col-span-2 lg:col-span-3",
  4: "md:col-span-2 lg:col-span-4",
};

/**
 * Computes, per card, whether it should stretch to fill the rest of its row
 * on the 4-col desktop breakpoint. Two cases:
 * - A single selected metric always fills the full row (no lone half-empty card).
 * - The last card in the list, if it would otherwise start a fresh row alone
 *   (nothing after it to backfill via `grid-auto-flow: dense`), stretches to
 *   fill the remaining columns in that row instead of leaving them blank.
 *
 * `dense` (set on the container) independently backfills any *earlier* gaps
 * using later cards; this function handles the one gap dense can't fix: the
 * trailing gap after the very last card, since there's nothing after it to
 * pull forward.
 */
function computeStretchOverrides(ids: string[]): Map<string, number> {
  const overrides = new Map<string, number>();
  if (ids.length === 0) return overrides;

  if (ids.length === 1) {
    overrides.set(ids[0]!, DESKTOP_COLS);
    return overrides;
  }

  let col = 0; // 0-indexed column cursor in the simulated non-dense flow
  let rowStart = 0;
  for (let i = 0; i < ids.length; i++) {
    const def = getMetricDef(ids[i]!);
    const span = def ? Math.min(cardSpan(def), DESKTOP_COLS) : 1;
    if (col + span > DESKTOP_COLS) {
      col = 0;
      rowStart = i;
    }
    col += span;
    if (col >= DESKTOP_COLS) {
      col = 0;
      rowStart = i + 1;
    }
  }
  // Cursor didn't land on a row boundary -> the last row is short. Stretch
  // the final card to close the gap.
  if (col !== 0 && rowStart <= ids.length - 1) {
    const lastId = ids[ids.length - 1]!;
    const def = getMetricDef(lastId);
    const ownSpan = def ? Math.min(cardSpan(def), DESKTOP_COLS) : 1;
    const filledBefore = col - ownSpan;
    const stretched = DESKTOP_COLS - filledBefore;
    if (stretched > ownSpan) overrides.set(lastId, stretched);
  }
  return overrides;
}

/**
 * Same grid layout as MetricGrid, with native HTML5 drag-and-drop reordering
 * (no extra dependency — dnd-kit was more than this needs). Each card gets a
 * small grip handle in its top-left corner; dragging one over another swaps
 * their position in `ids` and calls `onReorder` with the new order.
 *
 * `grid-auto-flow: dense` backfills internal gaps (e.g. a span-2 chart that
 * doesn't fit the current row gets pushed down, and a later span-1 KPI is
 * pulled up to fill the leftover column). computeStretchOverrides handles the
 * one case dense can't: the last card having nothing after it to pull forward.
 */
export function DraggableMetricGrid({ ids, onReorder, renderItem }: DraggableMetricGridProps) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  const stretch = useMemo(() => computeStretchOverrides(ids), [ids]);

  const handleDrop = (targetId: string) => {
    if (!dragId || dragId === targetId) {
      setDragId(null);
      setOverId(null);
      return;
    }
    const from = ids.indexOf(dragId);
    const to = ids.indexOf(targetId);
    if (from === -1 || to === -1) return;
    const next = [...ids];
    next.splice(from, 1);
    next.splice(to, 0, dragId);
    onReorder(next);
    setDragId(null);
    setOverId(null);
  };

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 items-stretch [grid-auto-flow:dense] [grid-auto-rows:min-content]">
      {ids.map((id) => {
        const def = getMetricDef(id);
        const baseSpan = def ? cardSpan(def) : 1;
        const span = Math.min(stretch.get(id) ?? baseSpan, DESKTOP_COLS);
        return (
          <div
            key={id}
            draggable
            onDragStart={() => setDragId(id)}
            onDragOver={(e) => {
              e.preventDefault();
              if (overId !== id) setOverId(id);
            }}
            onDragLeave={() => setOverId((cur) => (cur === id ? null : cur))}
            onDrop={(e) => {
              e.preventDefault();
              handleDrop(id);
            }}
            onDragEnd={() => {
              setDragId(null);
              setOverId(null);
            }}
            className={`relative group h-full ${SPAN_CLASS[span] ?? SPAN_CLASS[1]} ${dragId === id ? "opacity-50" : ""} ${overId === id && dragId && dragId !== id ? "ring-2 ring-primary rounded-lg" : ""}`}
          >
            <div
              className="absolute left-1 top-1 z-10 cursor-grab rounded p-0.5 opacity-0 group-hover:opacity-60 hover:!opacity-100 transition-opacity bg-background/80"
              aria-label="Drag to reorder"
            >
              <GripVertical className="h-3.5 w-3.5 text-muted-foreground" />
            </div>
            {renderItem(id)}
          </div>
        );
      })}
    </div>
  );
}
