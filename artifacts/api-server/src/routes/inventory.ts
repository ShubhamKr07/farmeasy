import { Router, type Request, type Response } from "express";
import { eq, gt, and, asc } from "drizzle-orm";
import { z } from "zod";
import { db } from "@workspace/db";
import { inventoryItemsTable, facilitiesTable } from "@workspace/db";
import { generateShortId } from "../lib/utils";

const router = Router();

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

// ── Zod schemas ───────────────────────────────────────────────────────────────

// current_qty / max_qty are drizzle `numeric` columns — stored as strings, but
// the API must accept a *finite, non-negative number* and stringify it itself.
// Rejecting here means "abc", Infinity, and -5 never reach Postgres as an ugly
// unhandled numeric-parse / CHECK error (they surface as a clean 400 instead).
const qtySchema = z
  .number({ invalid_type_error: "currentQty/maxQty must be a number" })
  .finite("currentQty/maxQty must be a finite number")
  .nonnegative("currentQty/maxQty must be non-negative");

// ISO 8601 calendar date `YYYY-MM-DD` that parses to a real date. The regex
// rejects garbage shapes; the refine rejects impossible calendar dates whose
// digits still match the shape (e.g. "2024-13-01" — Date.parse → NaN).
const arrivalDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "arrivalDate must be a YYYY-MM-DD date string")
  .refine((v) => !Number.isNaN(Date.parse(v)), "arrivalDate is not a real date");

// Create: full payload. Cross-field `currentQty <= maxQty` is validated here
// (all values are present), defaulting an omitted quantity to 0 to match the
// previous `?? 0` behaviour.
const CreateInventorySchema = z
  .object({
    name: z.string().min(1, "name is required"),
    brand: z.string().nullable().optional(),
    category: z.string().nullable().optional(),
    qrCode: z.string().nullable().optional(),
    currentQty: qtySchema.optional(),
    maxQty: qtySchema.optional(),
    unit: z.string().min(1).optional(),
    arrivalDate: arrivalDateSchema.nullable().optional(),
  })
  .refine((d) => (d.currentQty ?? 0) <= (d.maxQty ?? 0), {
    message: "currentQty must be less than or equal to maxQty",
    path: ["currentQty"],
  });

// Patch: every scalar field optional + `.strict()` (unknown keys rejected).
// Cross-field `currentQty <= maxQty` is NOT validated here — the request alone
// doesn't know the stored values — it is validated against the merged,
// locked-row state inside the PATCH transaction (see below).
const PatchInventorySchema = z
  .object({
    name: z.string().min(1, "name must not be blank").optional(),
    brand: z.string().nullable().optional(),
    category: z.string().nullable().optional(),
    qrCode: z.string().nullable().optional(),
    currentQty: qtySchema.optional(),
    maxQty: qtySchema.optional(),
    unit: z.string().min(1).optional(),
    arrivalDate: arrivalDateSchema.nullable().optional(),
  })
  .strict();

function validate<T>(
  schema: z.ZodSchema<T>,
  data: unknown,
  res: Response,
): T | null {
  const result = schema.safeParse(data);
  if (!result.success) {
    res.status(400).json({
      error: "Validation failed",
      details: result.error.flatten(),
    });
    return null;
  }
  return result.data;
}

function formatItem(item: typeof inventoryItemsTable.$inferSelect) {
  return {
    id: item.id,
    name: item.name,
    brand: item.brand ?? null,
    category: item.category ?? null,
    qrCode: item.qrCode ?? null,
    itemCode: item.itemCode,
    currentQty: Number(item.currentQty),
    maxQty: Number(item.maxQty),
    unit: item.unit,
    arrivalDate: item.arrivalDate ?? null,
    createdAt: item.createdAt.toISOString(),
  };
}

router.get("/inventory", async (req: Request, res: Response) => {
  try {
    const cursor = req.query.cursor ? parseInt(req.query.cursor as string, 10) : undefined;
    const limit = Math.min(
      MAX_LIMIT,
      req.query.limit ? parseInt(req.query.limit as string, 10) || DEFAULT_LIMIT : DEFAULT_LIMIT,
    );

    // Keyset pagination on id. No `cursor`/`limit` param = first page, same
    // flat-array shape as before pagination existed.
    const conditions = cursor !== undefined ? [gt(inventoryItemsTable.id, cursor)] : [];

    const rows = await db
      .select()
      .from(inventoryItemsTable)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(asc(inventoryItemsTable.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore ? page[page.length - 1]!.id : null;

    if (req.query.cursor === undefined && req.query.limit === undefined) {
      return res.json(page.map(formatItem));
    }
    return res.json({ items: page.map(formatItem), nextCursor });
  } catch (err) {
    req.log.error(err);
    return res.status(500).json({ error: "Failed to fetch inventory" });
  }
});

router.post("/inventory", async (req: Request, res: Response) => {
  try {
    const body = validate(CreateInventorySchema, req.body, res);
    if (!body) return;

    // Facility resolution is session-context wiring deferred to a later
    // milestone (MT-M1) -- this pilot-default lookup unblocks typecheck for
    // this one handler now that inventory_items.facilityId is NOT NULL.
    const [defaultFacility] = await db
      .select({ id: facilitiesTable.id })
      .from(facilitiesTable)
      .orderBy(facilitiesTable.id)
      .limit(1);
    if (!defaultFacility) {
      return res.status(500).json({ error: "No facility configured" });
    }
    const facilityId = defaultFacility.id;

    let itemCode = generateShortId();
    let item: typeof inventoryItemsTable.$inferSelect | undefined;
    for (let attempt = 0; attempt < 5; attempt++) {
      [item] = await db
        .insert(inventoryItemsTable)
        .values({
          name: body.name,
          brand: body.brand ?? null,
          category: body.category ?? null,
          qrCode: body.qrCode ?? null,
          currentQty: String(body.currentQty ?? 0),
          maxQty: String(body.maxQty ?? 0),
          unit: body.unit ?? "g",
          arrivalDate: body.arrivalDate ?? null,
          facilityId,
          itemCode,
        })
        .onConflictDoNothing({ target: [inventoryItemsTable.facilityId, inventoryItemsTable.itemCode] })
        .returning();
      if (item) break;
      itemCode = generateShortId();
    }
    if (!item) {
      return res.status(500).json({ error: "Failed to generate a unique item code" });
    }

    return res.status(201).json(formatItem(item));
  } catch (err) {
    req.log.error(err);
    return res.status(500).json({ error: "Failed to create inventory item" });
  }
});

router.patch("/inventory/:id", async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params["id"] as string, 10);

    // Strict partial parse: every scalar field optional, unknown keys
    // rejected. Per-field type/range/date checks happen here; the cross-field
    // `currentQty <= maxQty` check happens below against the merged state.
    const body = validate(PatchInventorySchema, req.body, res);
    if (!body) return;

    const updateData: Partial<typeof inventoryItemsTable.$inferInsert> = {};
    if (body.name !== undefined) updateData.name = body.name;
    if (body.brand !== undefined) updateData.brand = body.brand;
    if (body.category !== undefined) updateData.category = body.category;
    if (body.qrCode !== undefined) updateData.qrCode = body.qrCode;
    if (body.currentQty !== undefined) updateData.currentQty = String(body.currentQty);
    if (body.maxQty !== undefined) updateData.maxQty = String(body.maxQty);
    if (body.unit !== undefined) updateData.unit = body.unit;
    if (body.arrivalDate !== undefined) updateData.arrivalDate = body.arrivalDate;

    // Empty PATCH: nothing to update. Reject cleanly rather than issuing an
    // UPDATE with an empty SET clause (a SQL syntax error).
    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({ error: "No updatable fields provided" });
    }

    // Validate the PATCH against the COMPLETE merged state, atomically.
    //
    // SELECT ... FOR UPDATE locks the row for the duration of this
    // transaction. A second concurrent PATCH on the same row blocks here until
    // this transaction commits, so it then reads *this* request's
    // already-applied change and rejects itself with a clean 400 if the
    // merged values would violate `currentQty <= maxQty` — instead of blindly
    // updating its own fields and relying on the DB's CHECK constraint to
    // throw an unhandled 500. Never read the row outside this transaction.
    const result = await db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(inventoryItemsTable)
        .where(eq(inventoryItemsTable.id, id))
        .for("update");

      if (!existing) return { kind: "not_found" as const };

      const mergedCurrent =
        body.currentQty !== undefined ? body.currentQty : Number(existing.currentQty);
      const mergedMax =
        body.maxQty !== undefined ? body.maxQty : Number(existing.maxQty);

      if (mergedCurrent > mergedMax) {
        return {
          kind: "invalid" as const,
          message: "currentQty must be less than or equal to maxQty",
        };
      }

      const [updated] = await tx
        .update(inventoryItemsTable)
        .set(updateData)
        .where(eq(inventoryItemsTable.id, id))
        .returning();

      return { kind: "ok" as const, item: updated };
    });

    if (result.kind === "not_found") {
      return res.status(404).json({ error: "Item not found" });
    }
    if (result.kind === "invalid") {
      return res.status(400).json({ error: result.message });
    }
    return res.json(formatItem(result.item));
  } catch (err) {
    req.log.error(err);
    return res.status(500).json({ error: "Failed to update inventory item" });
  }
});

router.delete("/inventory/:id", async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params["id"] as string, 10);
    const [item] = await db
      .delete(inventoryItemsTable)
      .where(eq(inventoryItemsTable.id, id))
      .returning();

    if (!item) return res.status(404).json({ error: "Item not found" });
    return res.json({ ok: true, id });
  } catch (err) {
    req.log.error(err);
    return res.status(500).json({ error: "Failed to delete inventory item" });
  }
});

export default router;
