// lib/db/src/scope.ts
import { sql } from "drizzle-orm";
import { db } from "./index.js";

export interface TenantContext {
  organizationId: number;
  facilityId?: number;
}

/**
 * Wraps a scoped query in a transaction that sets SET LOCAL session
 * variables for RLS policies to key on (app.org_id, app.facility_id). This
 * is the ONLY sanctioned way route handlers touch a tenant-scoped table --
 * scripts/ci/check-tenant-scope.mjs (a later task) enforces this in CI.
 *
 * SET LOCAL resets automatically at transaction end, which is exactly
 * compatible with Supabase's transaction-pooler connection reuse (a bare
 * session-level SET would leak across pooled connections; SET LOCAL cannot).
 *
 * Throws synchronously (before opening a transaction) if ctx has no
 * organizationId -- never a silent unscoped fallback.
 */
export async function withTenantScope<T>(
  ctx: TenantContext,
  fn: Parameters<typeof db.transaction>[0],
): Promise<T> {
  if (!ctx || !ctx.organizationId) {
    throw new Error("withTenantScope called without a resolvable organization context");
  }
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL app.org_id = ${ctx.organizationId}`);
    if (ctx.facilityId !== undefined) {
      await tx.execute(sql`SET LOCAL app.facility_id = ${ctx.facilityId}`);
    }
    return fn(tx);
  }) as Promise<T>;
}
