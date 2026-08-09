import React from "react";
import { Sidebar } from "./Sidebar";
import { DemoBanner } from "./DemoBanner";
import { TopBar } from "./TopBar";
import { RightSidebar } from "./RightSidebar";
import { PanelProvider, usePanel } from "@/context/PanelContext";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Alerts } from "@/pages/alerts/Alerts";
import { BadTrays } from "@/pages/bad-trays/BadTrays";
import { CyclesPanel } from "@/pages/panels/CyclesPanel";
import { SeedLotsPanel } from "@/pages/panels/SeedLotsPanel";
import { ActionRequiredPanel } from "@/pages/panels/ActionRequiredPanel";
import { CommandPalette } from "@/components/command-palette";

function PanelSheets() {
  const { openPanel, close } = usePanel();
  return (
    <>
      <Sheet open={openPanel === "alerts"} onOpenChange={(o) => !o && close()}>
        <SheetContent side="right" className="w-[900px] max-w-[95vw] p-0 overflow-y-auto">
          <SheetHeader className="sr-only"><SheetTitle>System Alerts</SheetTitle></SheetHeader>
          <Alerts />
        </SheetContent>
      </Sheet>

      <Sheet open={openPanel === "bad-trays"} onOpenChange={(o) => !o && close()}>
        <SheetContent side="right" className="w-[900px] max-w-[95vw] p-0 overflow-y-auto">
          <SheetHeader className="sr-only"><SheetTitle>Bad Trays Analysis</SheetTitle></SheetHeader>
          <BadTrays />
        </SheetContent>
      </Sheet>

      <Sheet open={openPanel === "cycles"} onOpenChange={(o) => !o && close()}>
        <SheetContent side="right" className="w-[900px] max-w-[95vw] p-0 overflow-y-auto">
          <SheetHeader className="sr-only"><SheetTitle>Active Cycles</SheetTitle></SheetHeader>
          <CyclesPanel />
        </SheetContent>
      </Sheet>

      <Sheet open={openPanel === "seed-lots"} onOpenChange={(o) => !o && close()}>
        <SheetContent side="right" className="w-[900px] max-w-[95vw] p-0 overflow-y-auto">
          <SheetHeader className="sr-only"><SheetTitle>Active Seed Lots</SheetTitle></SheetHeader>
          <SeedLotsPanel />
        </SheetContent>
      </Sheet>

      <Sheet open={openPanel === "action-required"} onOpenChange={(o) => !o && close()}>
        <SheetContent side="right" className="w-[900px] max-w-[95vw] p-0 overflow-y-auto">
          <SheetHeader className="sr-only"><SheetTitle>Cycles Needing Action</SheetTitle></SheetHeader>
          <ActionRequiredPanel />
        </SheetContent>
      </Sheet>
    </>
  );
}

interface AppLayoutProps {
  children: React.ReactNode;
}

export function AppLayout({ children }: AppLayoutProps) {
  return (
    <PanelProvider>
      <div className="flex h-[100dvh] w-full overflow-hidden bg-background">
        <Sidebar />
        <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
          <DemoBanner />
          <TopBar />
          <main className="flex-1 overflow-auto bg-muted/20">
            <div className="h-full">
              {children}
            </div>
          </main>
        </div>
        <RightSidebar />
      </div>
      <PanelSheets />
      <CommandPalette />
    </PanelProvider>
  );
}
