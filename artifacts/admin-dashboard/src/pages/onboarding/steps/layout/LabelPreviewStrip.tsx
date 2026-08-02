const STAGE_NAMES: Record<string, string> = { S: "Seeding", F: "Fertigation", H: "Harvesting" };

export function LabelPreviewStrip({ stageInitial }: { stageInitial: string }) {
  // LAY-004 scheme: {stage initial}{room index}-C{channel}-S{shelf}. Phase 1
  // room index is always 1. Channel 2 / Shelf 4 are a static illustrative
  // example (matching the README's literal "S1-C2-S4" spec) — not derived
  // from the actual entered counts, since real position codes don't exist
  // until the layout is actually created and each row gets a real id.
  const exampleCode = `${stageInitial}1-C2-S4`;
  return (
    <div className="rounded-lg bg-[hsl(248_20%_95%)] p-3 flex flex-wrap items-center gap-2 text-xs">
      <span className="text-muted-foreground">Your position labels:</span>
      <span className="font-mono bg-white border border-border rounded px-1.5 py-0.5">{exampleCode}</span>
      <span className="text-muted-foreground">
        = {STAGE_NAMES[stageInitial] ?? stageInitial} · Channel 2 · Shelf 4 — print them from the Layout tab after
        setup
      </span>
    </div>
  );
}
