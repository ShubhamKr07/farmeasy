import {
  LayoutDashboard,
  Factory,
  Package,
  Truck,
  Grid3X3,
  User,
  Settings,
  DollarSign,
  Globe,
  type LucideIcon,
} from "lucide-react";
import type { OrgRole } from "@/hooks/use-org-role";

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /**
   * Roles allowed to see this entry. Omitted = visible to everyone. UX-only
   * gate (mirrors useOrgRole's TeamSection/TechnicianDeniedScreen pattern) —
   * the server-side requireRole check is the real access control.
   */
  roles?: OrgRole[];
}

/** Primary operations destinations. Shared by Sidebar and the mobile drawer. */
export const NAV_ITEMS: NavItem[] = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/cycles", label: "Cycles", icon: Factory },
  { href: "/inventory", label: "Inventory", icon: Package },
  { href: "/shipments", label: "Shipments", icon: Truck },
  { href: "/accounting", label: "Accounting", icon: DollarSign },
  { href: "/layout", label: "Layout", icon: Grid3X3 },
  { href: "/org", label: "Org Overview", icon: Globe, roles: ["owner", "admin"] },
];

/** Secondary system destinations. */
export const PAGE_ITEMS: NavItem[] = [
  { href: "/profile", label: "Admin Profile", icon: User },
  { href: "/settings", label: "Settings", icon: Settings },
];
