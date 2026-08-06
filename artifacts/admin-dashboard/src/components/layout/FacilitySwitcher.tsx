import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Building2, Check, Plus } from "lucide-react";
import { useActiveFacility } from "@/hooks/use-active-facility";

/**
 * Header facility switcher (TEN-008). Renders nothing for a single-facility
 * org (per the design's "hidden entirely when the org has exactly one
 * facility") — there is nothing meaningful to switch between yet.
 */
export function FacilitySwitcher() {
  const { facilities, activeFacilityId, selectFacility, startAddFacility } = useActiveFacility();

  if (facilities.length <= 1) return null;

  const active = facilities.find((f) => f.id === activeFacilityId);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="gap-2" data-testid="button-facility-switcher">
          <Building2 className="h-4 w-4" />
          <span className="max-w-[140px] truncate">{active?.facilityName ?? "Select facility"}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel>Facilities</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {facilities.map((f) => (
          <DropdownMenuItem key={f.id} onClick={() => selectFacility(f.id)} data-testid={`facility-option-${f.id}`}>
            {f.id === activeFacilityId ? <Check className="mr-2 h-4 w-4" /> : <span className="mr-2 h-4 w-4" />}
            {f.facilityName}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={startAddFacility} data-testid="button-add-facility">
          <Plus className="mr-2 h-4 w-4" />
          Add facility
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
