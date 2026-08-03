// lib/db/src/scope.ts
import { sql } from "drizzle-orm";
import { db } from "./index.js";

export interface TenantContext {
  organizationId: number;
  facilityId?: number;
}

/**
 * Wraps a scoped query in a transaction that sets transaction-local session
 * variables for RLS policies to key on (app.org_id, app.facility_id). This
 * is the ONLY sanctioned way route handlers touch a tenant-scoped table --
 * scripts/ci/check-tenant-scope.mjs (a later task) enforces this in CI.
 *
 * The variables are set via Postgres's set_config(name, value, true) built-in
 * (NOT a literal `SET LOCAL ...` statement, because SET LOCAL's grammar rejects
 * bind parameters and Drizzle always parameterizes interpolated values).
 * set_config()'s third argument true means "is_local", so the setting resets
 * automatically at transaction end -- exactly compatible with Supabase's
 * transaction-pooler connection reuse (a bare session-level SET would leak
 * across pooled connections; a transaction-local setting cannot).
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
    // set_config(..., true) -- NOT a literal `SET LOCAL ...` string -- because
    // Postgres's SET/SET LOCAL grammar does not accept bind parameters in that
    // position (a real syntax error, confirmed empirically: `SET LOCAL x = $1`
    // fails with SQLSTATE 42601). set_config() is a normal function call, so it
    // takes real parameters safely, and its third argument (true = "is_local")
    // gives the exact same transaction-scoped reset behavior as SET LOCAL.
    await tx.execute(sql`SELECT set_config('app.org_id', ${ctx.organizationId.toString()}, true)`);
    if (ctx.facilityId !== undefined) {
      await tx.execute(sql`SELECT set_config('app.facility_id', ${ctx.facilityId.toString()}, true)`);
    }
    return fn(tx);
  }) as Promise<T>;
}
