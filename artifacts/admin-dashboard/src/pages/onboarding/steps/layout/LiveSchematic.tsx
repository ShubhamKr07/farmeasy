export function LiveSchematic({
  zoneLabel,
  channels,
  racksPerChannel,
  levelsPerRack,
}: {
  zoneLabel: string;
  channels: number;
  racksPerChannel: number;
  levelsPerRack: number;
}) {
  // README: bars are flattened per channel (not visually grouped by rack) —
  // one 20px bar per level, racksPerChannel * levelsPerRack bars per column.
  const barsPerChannel = racksPerChannel * levelsPerRack;
  const totalLevels = channels * barsPerChannel;

  return (
    <div className="rounded-xl border border-border bg-white p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold">{zoneLabel} — live schematic</h2>
        <span className="text-xs text-muted-foreground">{totalLevels} levels total</span>
      </div>
      {channels === 0 || barsPerChannel === 0 ? (
        <p className="text-xs text-muted-foreground">
          Enter channels, racks, and levels to preview the layout.
        </p>
      ) : (
        <div className="flex gap-3 overflow-x-auto">
          {Array.from({ length: channels }).map((_, channelIdx) => (
            <div key={channelIdx} className="flex flex-col items-center gap-1">
              <div className="flex flex-col-reverse gap-1">
                {Array.from({ length: barsPerChannel }).map((_, barIdx) => {
                  // One representative bar (first channel, first level) is
                  // highlighted solid brand green and captioned, tying it to
                  // the LabelPreviewStrip example below (README spec).
                  const isHighlighted = channelIdx === 0 && barIdx === 0;
                  return (
                    <div
                      key={barIdx}
                      className={
                        isHighlighted
                          ? "h-5 w-8 rounded-sm bg-primary"
                          : "h-5 w-8 rounded-sm bg-[hsl(142_30%_92%)] border border-[hsl(142_25%_84%)]"
                      }
                      title={isHighlighted ? `C${channelIdx + 1}-S${barIdx + 1}` : undefined}
                    />
                  );
                })}
              </div>
              <span className="text-xs text-muted-foreground mt-1">C{channelIdx + 1}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
