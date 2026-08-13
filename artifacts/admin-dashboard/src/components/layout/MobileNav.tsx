import React from "react";
import { Link, useLocation } from "wouter";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { NAV_ITEMS, PAGE_ITEMS, type NavItem } from "./nav-items";
import { useOrgRole } from "@/hooks/use-org-role";

function NavList({ onNavigate }: { onNavigate: () => void }) {
  const [location] = useLocation();
  const { role, loading: roleLoading } = useOrgRole();

  // Same role-gating rule as Sidebar: hide gated entries until the role
  // claim resolves, then show only to allowed roles. UX-only — the server
  // requireRole 403 is the real access control.
  const visibleNavItems = NAV_ITEMS.filter(
    (item) => !item.roles || (!roleLoading && role !== null && item.roles.includes(role)),
  );

  const render = (item: NavItem) => {
    const isActive = location === item.href;
    const Icon = item.icon;
    return (
      <Link key={item.href} href={item.href}>
        <button
          type="button"
          onClick={onNavigate}
          className={`w-full flex items-center gap-3 px-3 py-3 min-h-[44px] rounded-md text-sm font-medium transition-colors hover:bg-muted ${
            isActive ? "bg-primary/10 text-primary" : "text-sidebar-foreground"
          }`}
          data-testid={`mobilenav-${item.label.toLowerCase().replace(/\s+/g, "-")}`}
        >
          <Icon
            className={`h-4 w-4 ${isActive ? "text-primary" : "text-muted-foreground"}`}
          />
          {item.label}
        </button>
      </Link>
    );
  };

  return (
    <nav className="flex flex-col gap-6 px-3 py-4">
      <div className="space-y-1">
        <div className="px-3 text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
          Operations
        </div>
        {visibleNavItems.map(render)}
      </div>
      <div className="space-y-1">
        <div className="px-3 text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
          System
        </div>
        {PAGE_ITEMS.map(render)}
      </div>
    </nav>
  );
}

export function MobileNav({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="left" className="w-[280px] max-w-[85vw] p-0 overflow-y-auto">
        <SheetHeader className="h-16 flex items-center px-6 border-b">
          <SheetTitle asChild>
            <img src="/logo-lockup.svg" alt="FarmSmart" className="h-[37px] w-auto" />
          </SheetTitle>
        </SheetHeader>
        <NavList onNavigate={() => onOpenChange(false)} />
      </SheetContent>
    </Sheet>
  );
}
