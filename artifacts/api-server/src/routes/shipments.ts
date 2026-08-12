import { Router, type Request, type Response } from "express";
import { eq, and, gt, desc, asc, ilike } from "drizzle-orm";
import { withTenantScope, shipmentsTable } from "@workspace/db";
import { requireTenantContext } from "../middlewares/tenantContext";
import { requireRole } from "../middlewares/requireRole";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const router = Router();

// All routes in THIS router require a resolved tenant AND owner/admin — a
// technician could otherwise create/modify/delete shipments via direct API
// call with no server-side check (Task 11 remediation, same self-gate
// pattern as invitations.ts/members.ts). Must be mounted in app.ts's tier 4
// (after every router a technician is allowed to reach) — see app.ts's
// tiering comment.
router.use(requireTenantContext, requireRole("owner", "admin"));

function generateShortId(): string {
  return "SHP-" + Math.random().toString(36).slice(2, 8).toUpperCase();
}

function formatShipment(s: typeof shipmentsTable.$inferSelect) {
  return {
    id: s.id,
    shortId: s.shortId,
    client: s.client,
    productDescription: s.productDescription ?? null,
    yieldSoldKg: s.yieldSoldKg ? Number(s.yieldSoldKg) : null,
    revenueUsd: s.revenueUsd ? Number(s.revenueUsd) : null,
    shippingDate: s.shippingDate ?? null,
    status: s.status,
    createdAt: s.createdAt.toISOString(),
  };
}

type ShipmentListQuery = {
  cursor?: number;
  limit: number;
  status?: "pending" | "in_progress" | "complete";
  client?: string;
};

/**
 * Escape SQL LIKE/ILIKE metacharacters in a literal substring so a client
 * named e.g. "50%_Farms" matches exactly those characters — not "any chars"
 * (%) or "any single char" (_), and a backslash in the name stays literal.
 * Backslash is escaped FIRST (it's the escape character itself), then % and _.
 *
 * Postgres's default LIKE/ILIKE escape character is a backslash, and drizzle's
 * `ilike(col, value)` builds `col ilike ${value}` with the pattern as a bound
 * parameter (not an interpolated string literal), so `standard_conforming_strings`
 * never applies — the escaped value is consumed verbatim by Postgres's pattern
 * matcher. No explicit `ESCAPE '\\'` clause is needed.
 */
function escapeClientPattern(input: string): string {
  return input
    .replace(/\\/g, "\\\\")
    .replace(/%/g, "\\%")
    .replace(/_/g, "\\_");
}

/** Parse + validate the GET /shipments query into the typed list params. */
function parseShipmentListQuery(req: Request): ShipmentListQuery {
  const rawStatus = req.query.status as string | undefined;
  const status =
    rawStatus && ["in_progress", "complete", "pending"].includes(rawStatus)
      ? (rawStatus as ShipmentListQuery["status"])
      : undefined;

  const rawClient = req.query.client as string | undefined;
  const client = rawClient && rawClient.length > 0 ? rawClient : undefined;

  const parsedCursor = req.query.cursor
    ? parseInt(req.query.cursor as string, 10)
    : undefined;
  const cursor = parsedCursor !== undefined && Number.isFinite(parsedCursor) ? parsedCursor : undefined;

  const limit = Math.min(
    MAX_LIMIT,
    req.query.limit
      ? parseInt(req.query.limit as string, 10) || DEFAULT_LIMIT
      : DEFAULT_LIMIT,
  );

  return { cursor, limit, status, client };
}

router.get("/shipments", async (req: Request, res: Response) => {
  try {
    const { cursor, limit, status, client } = parseShipmentListQuery(req);

    // Build the FULL where clause (cursor + status + client) BEFORE the
    // limit+1, so filtered queries skip non-matching rows server-side rather
    // than truncating them into the limit+1 window. The previous code ran the
    // keyset query first and applied status/client as JS .filter() on the
    // already-truncated result set: when enough non-matching rows preceded the
    // first match in id order, the matches never left the DB (beyond the
    // limit+1 window), so they silently vanished — and hasMore/nextCursor were
    // computed from the wrong (post-filter, already-truncated) set, breaking
    // pagination for any filtered query.
    const conditions = [eq(shipmentsTable.facilityId, req.tenant!.facilityId)];
    if (cursor !== undefined) conditions.push(gt(shipmentsTable.id, cursor));
    if (status) conditions.push(eq(shipmentsTable.status, status));
    if (client) {
      conditions.push(ilike(shipmentsTable.client, `%${escapeClientPattern(client)}%`));
    }

    const rows = await withTenantScope(req.tenant!, (tx) =>
      tx
        .select()
        .from(shipmentsTable)
        .where(and(...conditions))
        .orderBy(asc(shipmentsTable.id))
        .limit(limit + 1),
    );

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore ? page[page.length - 1]!.id : null;

    // Unpaginated callers (no cursor/limit query params) keep the original
    // flat-array response shape; opt-in pagination wraps with {items,nextCursor}.
    if (req.query.cursor === undefined && req.query.limit === undefined) {
      return res.json(page.map(formatShipment));
    }
    return res.json({ items: page.map(formatShipment), nextCursor });
  } catch (err) {
    req.log.error(err);
    return res.status(500).json({ error: "Failed to fetch shipments" });
  }
});

router.post("/shipments", async (req: Request, res: Response) => {
  try {
    const { client, productDescription, yieldSoldKg, revenueUsd, shippingDate, status } = req.body;
    if (!client) return res.status(400).json({ error: "client is required" });

    let shortId = generateShortId();
    let shipment: typeof shipmentsTable.$inferSelect | undefined;
    for (let attempt = 0; attempt < 5; attempt++) {
      [shipment] = await withTenantScope(req.tenant!, (tx) =>
        tx
          .insert(shipmentsTable)
          .values({
            shortId,
            client,
            productDescription: productDescription ?? null,
            yieldSoldKg: yieldSoldKg ? String(yieldSoldKg) : null,
            revenueUsd: revenueUsd ? String(revenueUsd) : null,
            shippingDate: shippingDate ?? null,
            status: status ?? "pending",
            facilityId: req.tenant!.facilityId,
          })
          .onConflictDoNothing({ target: [shipmentsTable.shortId] })
          .returning(),
      );
      if (shipment) break;
      shortId = generateShortId();
    }

    if (!shipment) {
      return res.status(500).json({ error: "Failed to generate a unique shipment short ID" });
    }

    return res.status(201).json(formatShipment(shipment));
  } catch (err) {
    req.log.error(err);
    return res.status(500).json({ error: "Failed to create shipment" });
  }
});

router.patch("/shipments/:id/status", async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params["id"] as string, 10);
    const { status } = req.body;

    if (!["in_progress", "complete", "pending"].includes(status)) {
      return res.status(400).json({ error: "Invalid status" });
    }

    const [shipment] = await withTenantScope(req.tenant!, (tx) =>
      tx
        .update(shipmentsTable)
        .set({ status })
        .where(and(eq(shipmentsTable.id, id), eq(shipmentsTable.facilityId, req.tenant!.facilityId)))
        .returning(),
    );

    if (!shipment) return res.status(404).json({ error: "Shipment not found" });
    return res.json(formatShipment(shipment));
  } catch (err) {
    req.log.error(err);
    return res.status(500).json({ error: "Failed to update shipment status" });
  }
});

router.patch("/shipments/:id", async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params["id"] as string, 10);
    const { client, productDescription, yieldSoldKg, revenueUsd, shippingDate, status } = req.body;

    const updateData: Partial<typeof shipmentsTable.$inferInsert> = {};
    if (client !== undefined) updateData.client = client;
    if (productDescription !== undefined) updateData.productDescription = productDescription;
    if (yieldSoldKg !== undefined) updateData.yieldSoldKg = yieldSoldKg ? String(yieldSoldKg) : null;
    if (revenueUsd !== undefined) updateData.revenueUsd = revenueUsd ? String(revenueUsd) : null;
    if (shippingDate !== undefined) updateData.shippingDate = shippingDate;
    if (status !== undefined) {
      if (!["in_progress", "complete", "pending"].includes(status)) {
        return res.status(400).json({ error: "Invalid status" });
      }
      updateData.status = status;
    }

    const [shipment] = await withTenantScope(req.tenant!, (tx) =>
      tx
        .update(shipmentsTable)
        .set(updateData)
        .where(and(eq(shipmentsTable.id, id), eq(shipmentsTable.facilityId, req.tenant!.facilityId)))
        .returning(),
    );

    if (!shipment) return res.status(404).json({ error: "Shipment not found" });
    return res.json(formatShipment(shipment));
  } catch (err) {
    req.log.error(err);
    return res.status(500).json({ error: "Failed to update shipment" });
  }
});

router.delete("/shipments/:id", async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params["id"] as string, 10);
    const [shipment] = await withTenantScope(req.tenant!, (tx) =>
      tx
        .delete(shipmentsTable)
        .where(and(eq(shipmentsTable.id, id), eq(shipmentsTable.facilityId, req.tenant!.facilityId)))
        .returning(),
    );

    if (!shipment) return res.status(404).json({ error: "Shipment not found" });
    return res.json({ ok: true, id });
  } catch (err) {
    req.log.error(err);
    return res.status(500).json({ error: "Failed to delete shipment" });
  }
});

export default router;
