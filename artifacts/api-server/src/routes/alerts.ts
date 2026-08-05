import { Router, type Request, type Response } from "express";
import { eq, and, desc } from "drizzle-orm";
import { withTenantScope, alertsTable } from "@workspace/db";

const router = Router();

function formatAlert(a: typeof alertsTable.$inferSelect) {
  return {
    id: a.id,
    title: a.title,
    description: a.description ?? null,
    location: a.location ?? null,
    severity: a.severity,
    status: a.status,
    actionType: a.actionType ?? null,
    actionNotes: a.actionNotes ?? null,
    createdAt: a.createdAt.toISOString(),
    resolvedAt: a.resolvedAt?.toISOString() ?? null,
  };
}

router.get("/alerts", async (req: Request, res: Response) => {
  try {
    const status = req.query.status as string | undefined;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;

    const rows = await withTenantScope(req.tenant!, (tx) => {
      const facilityCond = eq(alertsTable.facilityId, req.tenant!.facilityId);
      if (status && ["current", "resolved", "dismissed"].includes(status)) {
        return tx
          .select()
          .from(alertsTable)
          .where(and(facilityCond, eq(alertsTable.status, status as "current" | "resolved" | "dismissed")))
          .orderBy(desc(alertsTable.createdAt));
      }
      return tx.select().from(alertsTable).where(facilityCond).orderBy(desc(alertsTable.createdAt));
    });

    const result = rows.map(formatAlert);
    return res.json(limit ? result.slice(0, limit) : result);
  } catch (err) {
    req.log.error(err);
    return res.status(500).json({ error: "Failed to fetch alerts" });
  }
});

router.post("/alerts", async (req: Request, res: Response) => {
  try {
    const { title, description, location, severity } = req.body;
    if (!title) return res.status(400).json({ error: "title is required" });

    const [alert] = await withTenantScope(req.tenant!, (tx) =>
      tx
        .insert(alertsTable)
        .values({
          title,
          description: description ?? null,
          location: location ?? null,
          severity: severity ?? "warning",
          status: "current",
          facilityId: req.tenant!.facilityId,
        })
        .returning(),
    );

    return res.status(201).json(formatAlert(alert));
  } catch (err) {
    req.log.error(err);
    return res.status(500).json({ error: "Failed to create alert" });
  }
});

router.patch("/alerts/:id", async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params["id"] as string, 10);
    const { status } = req.body;

    if (!["resolved", "dismissed"].includes(status)) {
      return res.status(400).json({ error: "status must be resolved or dismissed" });
    }

    const [alert] = await withTenantScope(req.tenant!, (tx) =>
      tx
        .update(alertsTable)
        .set({ status, resolvedAt: new Date() })
        .where(and(eq(alertsTable.id, id), eq(alertsTable.facilityId, req.tenant!.facilityId)))
        .returning(),
    );

    if (!alert) return res.status(404).json({ error: "Alert not found" });
    return res.json(formatAlert(alert));
  } catch (err) {
    req.log.error(err);
    return res.status(500).json({ error: "Failed to update alert" });
  }
});

router.post("/alerts/:id/action", async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params["id"] as string, 10);
    const { actionType, notes } = req.body;

    if (!actionType) return res.status(400).json({ error: "actionType is required" });

    const [alert] = await withTenantScope(req.tenant!, (tx) =>
      tx
        .update(alertsTable)
        .set({ status: "resolved", actionType, actionNotes: notes ?? null, resolvedAt: new Date() })
        .where(
          and(
            eq(alertsTable.id, id),
            eq(alertsTable.status, "current"),
            eq(alertsTable.facilityId, req.tenant!.facilityId),
          ),
        )
        .returning(),
    );

    if (!alert) return res.status(404).json({ error: "Alert not found or already resolved" });
    return res.json(formatAlert(alert));
  } catch (err) {
    req.log.error(err);
    return res.status(500).json({ error: "Failed to take action on alert" });
  }
});

export default router;
