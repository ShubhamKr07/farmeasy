import { Router, type Request, type Response } from "express";
import { eq, and, isNull } from "drizzle-orm";
import { withTenantScope, tasksTable } from "@workspace/db";

const router = Router();

function formatTask(t: typeof tasksTable.$inferSelect) {
  return {
    id: t.id,
    cycleId: t.cycleId ?? null,
    type: t.type,
    status: t.status,
    assignee: t.assignee ?? null,
    dueAt: t.dueAt?.toISOString() ?? null,
    completedAt: t.completedAt?.toISOString() ?? null,
    createdBy: t.userId ?? null,
    createdAt: t.createdAt.toISOString(),
  };
}

router.get("/tasks", async (req: Request, res: Response) => {
  try {
    const status = req.query["status"] as string | undefined;
    const facilityId = req.tenant!.facilityId;
    const conds = [eq(tasksTable.facilityId, facilityId)];
    if (status === "pending" || status === "in_progress" || status === "done") {
      // Explicit valid status filter: return matching tasks of that status
      // (including completed ones for status=done). Replaces the open-tasks
      // default entirely — these branches are mutually exclusive, otherwise
      // status=done would AND "status = done" with "completedAt IS NULL",
      // which no row can satisfy (a done task always has completedAt set).
      conds.push(eq(tasksTable.status, status));
    } else {
      // No (or invalid) status filter: default to open tasks only.
      conds.push(isNull(tasksTable.completedAt));
    }
    const rows = await withTenantScope(req.tenant!, (tx) =>
      tx.select().from(tasksTable).where(and(...conds)).orderBy(tasksTable.dueAt),
    );
    return res.json(rows.map(formatTask));
  } catch (err) {
    req.log.error(err);
    return res.status(500).json({ error: "Failed to fetch tasks" });
  }
});

router.post("/tasks", async (req: Request, res: Response) => {
  try {
    const { cycleId, type, assignee, dueAt } = req.body;
    if (!type) return res.status(400).json({ error: "type is required" });
    const [t] = await withTenantScope(req.tenant!, (tx) =>
      tx
        .insert(tasksTable)
        .values({
          cycleId: cycleId ?? null,
          type,
          status: "pending",
          assignee: assignee ?? null,
          dueAt: dueAt ? new Date(dueAt) : null,
          facilityId: req.tenant!.facilityId,
        })
        .returning(),
    );
    return res.status(201).json(formatTask(t));
  } catch (err) {
    req.log.error(err);
    return res.status(500).json({ error: "Failed to create task" });
  }
});

router.patch("/tasks/:id", async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params["id"] as string, 10);
    const { status, assignee, dueAt, completedAt } = req.body;
    const update: Partial<typeof tasksTable.$inferInsert> = {};
    if (status !== undefined) {
      if (!["pending", "in_progress", "done"].includes(status)) {
        return res.status(400).json({ error: "Invalid status" });
      }
      update.status = status as "pending" | "in_progress" | "done";
      if (status === "done") update.completedAt = completedAt ? new Date(completedAt) : new Date();
    }
    if (assignee !== undefined) update.assignee = assignee;
    if (dueAt !== undefined) update.dueAt = dueAt ? new Date(dueAt) : null;

    const [t] = await withTenantScope(req.tenant!, (tx) =>
      tx
        .update(tasksTable)
        .set(update)
        .where(and(eq(tasksTable.id, id), eq(tasksTable.facilityId, req.tenant!.facilityId)))
        .returning(),
    );
    if (!t) return res.status(404).json({ error: "Task not found" });
    return res.json(formatTask(t));
  } catch (err) {
    req.log.error(err);
    return res.status(500).json({ error: "Failed to update task" });
  }
});

export default router;
