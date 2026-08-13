// artifacts/admin-dashboard/src/components/metrics/MetricDefinitionTooltip.tsx
//
// WAI-ARIA definition tooltip (HLP-001/002, Task 7).
//
// Renders the ⓘ trigger + the three-line definition panel for a metric card
// title:
//   Line 1: bold term        (entry.term)
//   Line 2: formula / source (entry.formula)
//   Line 3: explicit window  (entry.window — resolved from WINDOW_* constants,
//                            never the raw "7d" token)
//
// Behavior (plan §2):
//   - Trigger: ⓘ icon, keyboard-focusable (<button>), visible focus ring.
//   - Open on focus (keyboard) AND on click/tap. Hover is a courtesy open on
//     pointer devices but never the *only* way in — keyboard + touch must work.
//   - Touch: tap-to-open, tap-outside-to-dismiss (focus/click both toggle).
//   - ARIA: trigger is aria-describedby the panel; panel has role="tooltip".
//   - Esc dismisses; the trigger keeps focus.
//
// Uses the existing radix Tooltip primitives
// (@/components/ui/tooltip) for portal + positioning + dark styling, but the
// open state is controlled here so focus/click/touch can all drive it (radix
// Tooltip defaults to hover-only, which fails the keyboard + touch contract).
//
// If `id` has no catalog entry, the panel renders an explicit "definition
// unavailable" fallback — never a silently-empty tooltip. CI
// (scripts/ci/check-metric-definitions.mjs) prevents that fallback from ever
// shipping for a kpi/stat metric.
import * as React from "react";
import { Info } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { getDefinition } from "@/lib/definitions-catalog";
import { cn } from "@/lib/utils";

interface MetricDefinitionTooltipProps {
  /** MetricDef.id — looked up in DEFINITIONS_CATALOG. */
  id: string;
  /** Optional accessible label override; defaults to "Definition of {term}". */
  ariaLabel?: string;
  className?: string;
}

/**
 * Wraps the ⓘ icon in a focusable button + ARIA tooltip. Place this inline
 * next to a card title:
 *
 *   <CardTitle className="…">Total Yield (Week)</CardTitle>
 *   <MetricDefinitionTooltip id="ov.yield.week" />
 */
export function MetricDefinitionTooltip({ id, ariaLabel, className }: MetricDefinitionTooltipProps) {
  const entry = getDefinition(id);
  // Stable id linking the trigger (aria-describedby) to the panel (role tooltip).
  const tooltipId = React.useId();
  const [open, setOpen] = React.useState(false);

  const label = ariaLabel ?? (entry ? `Definition of ${entry.term}` : "Metric definition");

  // A pointer press (mouse/touch) focuses the button *before* firing click.
  // Without this flag, onFocus would open the panel and then onClick (toggle)
  // would immediately close it, so a click would never open the tooltip. We
  // mark pointer-driven focus so onFocus defers to the upcoming click; pure
  // keyboard focus (Tab) still opens as required.
  const pointerActiveRef = React.useRef(false);

  const closeOnEscape = React.useCallback((e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      setOpen(false);
    }
  }, []);

  // Esc-to-dismiss only while open; avoids stealing Esc from dialogs/panels.
  React.useEffect(() => {
    if (!open) return;
    document.addEventListener("keydown", closeOnEscape, true);
    return () => document.removeEventListener("keydown", closeOnEscape, true);
  }, [open, closeOnEscape]);

  return (
    <TooltipProvider delayDuration={100} disableHoverableContent={false}>
      {/* Controlled `open` only — no onOpenChange. Radix's onOpenChange would
          fight the button's onClick/OnFocus handlers: on a click it fires
          close (because the trigger loses hover on pointerup), clobbering the
          toggle and leaving aria-expanded stuck false. By dropping it, the
          button's own event handlers are the single source of truth for state,
          and radix just reads `open` to render/hide the portal. */}
      <Tooltip open={open}>
        {/* asChild so the <button> (not the radix wrapper) is the focusable,
            click-handling element — keyboard + touch both go through it. */}
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-describedby={open ? tooltipId : undefined}
            aria-label={label}
            aria-expanded={open}
            // Focus opens the panel for keyboard users; click/tap toggles it
            // (so touch users can open AND dismiss via the same icon). A
            // pointer press focuses the button first — in that case defer to
            // the click handler (pointerActiveRef) so a click opens, not
            // focus-then-toggle-close. Hover is left to radix.
            onPointerDown={() => {
              pointerActiveRef.current = true;
            }}
            onFocus={() => {
              if (pointerActiveRef.current) return;
              setOpen(true);
            }}
            onClick={() => {
              setOpen((v) => !v);
              pointerActiveRef.current = false;
            }}
            onBlur={(e) => {
              pointerActiveRef.current = false;
              // If focus moves outside the tooltip entirely, dismiss. Radix
              // also dismisses on pointer-out; this covers the keyboard path.
              if (!e.currentTarget.parentElement?.contains(e.relatedTarget as Node)) {
                setOpen(false);
              }
            }}
            className={cn(
              "inline-flex items-center justify-center rounded-full p-0.5",
              "text-muted-foreground hover:text-foreground",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
              "cursor-help",
              className,
            )}
          >
            <Info className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </TooltipTrigger>
        <TooltipContent
          id={tooltipId}
          role="tooltip"
          side="top"
          className={cn(
            "max-w-xs sm:max-w-sm px-3 py-2",
            "text-primary-foreground leading-snug",
          )}
        >
          {entry ? (
            <div className="space-y-1">
              {/* Line 1: bold term + plain definition. */}
              <div>
                <span className="font-semibold">{entry.term}</span>
                <span className="opacity-90"> — {entry.definition}</span>
              </div>
              {/* Line 2: formula / source attribution. */}
              <div className="text-[12px] opacity-90">{entry.formula}</div>
              {/* Line 3: explicit, resolved time window. */}
              <div className="text-[12px] opacity-75 italic">{entry.window}</div>
            </div>
          ) : (
            // Explicit fallback — never an empty tooltip. CI keeps this off
            // the overview KPI/stat cards, but it's the safe render for an
            // unknown id (e.g. a not-yet-cataloged chart metric).
            <div className="text-xs">Definition unavailable.</div>
          )}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
