import type { InventoryItem } from "@workspace/api-client-react";

/**
 * Pure helpers for the InventoryItem QR-label flow (Task 8, INV-009/010).
 *
 * Extracted into a standalone module so they can be unit-tested in isolation
 * without booting the component tree (and its env-dependent transitive
 * imports). These functions are deterministic and side-effect free.
 */

// Helper: generate deterministic QR payload per item (idempotent)
export function generateQRPayload(item: InventoryItem): string {
  // Format: inv:{itemId}:{sanitizedName}
  const sanitized = item.name.toLowerCase().replace(/[^a-z0-9]/g, "-");
  return `inv:${item.id}:${sanitized}`;
}

// Helper: format arrival date for display
export function formatArrivalDate(item: InventoryItem): string {
  if (item.arrivalDate) {
    return new Date(item.arrivalDate).toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  }
  return "Date pending";
}

// Helper: generate item code (e.g., "SUP-0042")
export function generateItemCode(itemId: number): string {
  return `SUP-${String(itemId).padStart(4, "0")}`;
}
