import { Router, type Request, type Response } from "express";
import { eq, desc } from "drizzle-orm";
import { db } from "@workspace/db";
import { manualChecksTable, cyclesTable, alertsTable } from "@workspace/db";
import { signMediaReferences } from "../services/mediaUrls";

const router = Router();

const LOSS_PER_TRAY = 500;
const HIGH_SEVERITY_THRESHOLD = 5;

router.get("/bad-trays", async (req: Request, res: Response) => {
  try {
    const checks = await db
      .select({
        id: manualChecksTable.id,
        cycleId: manualChecksTable.cycleId,
        fullTrays: manualChecksTable.fullTrays,
        halfTrays: manualChecksTable.halfTrays,
        issue: manualChecksTable.issue,
        notes: manualChecksTable.notes,
        createdAt: manualChecksTable.createdAt,
        shortId: cyclesTable.shortId,
        seedName: cyclesTable.seedName,
        trayPosition: cyclesTable.trayPosition,
      })
      .from(manualChecksTable)
      .innerJoin(cyclesTable, eq(manualChecksTable.cycleId, cyclesTable.id))
      .where(eq(manualChecksTable.isBadTrays, true))
      .orderBy(desc(manualChecksTable.createdAt));

    const totalBadTrays = checks.reduce(
      (sum, c) => sum + c.fullTrays + Math.ceil(c.halfTrays * 0.5),
      0,
    );

    const issueMap: Record<
      string,
      { affectedTrays: number; count: number }
    > = {};
    for (const c of checks) {
      const key = c.issue ?? "Unknown";
      if (!issueMap[key]) issueMap[key] = { affectedTrays: 0, count: 0 };
      issueMap[key].affectedTrays += c.fullTrays + Math.ceil(c.halfTrays * 0.5);
      issueMap[key].count++;
    }

    const totalIssues = Object.values(issueMap).reduce((s, i) => s + i.count, 0);
    const issues = Object.entries(issueMap).map(([issue, data]) => ({
      issue,
      frequency: totalIssues > 0 ? Math.round((data.count / totalIssues) * 100) : 0,
      affectedTrays: data.affectedTrays,
      estimatedLoss: data.affectedTrays * LOSS_PER_TRAY,
    }));

    const manualEntries = checks.map((c) => ({
      id: c.id,
      trayId: `T-${c.shortId}`,
      zone: c.trayPosition ?? null,
      cropType: c.seedName,
      issue: c.issue ?? null,
      entryDate: c.createdAt.toISOString(),
      severity: c.fullTrays + c.halfTrays > 5 ? "High" : c.fullTrays + c.halfTrays > 2 ? "Medium" : "Low",
    }));

    return res.json({
      totalBadTrays,
      estimatedLoss: totalBadTrays * LOSS_PER_TRAY,
      issues,
      manualEntries,
    });
  } catch (err) {
    req.log.error(err);
    return res.status(500).json({ error: "Failed to fetch bad trays analysis" });
  }
});

router.post("/bad-trays/manual-checks", async (req: Request, res: Response) => {
  try {
    const { cycleId, fullTrays, halfTrays, issue, notes } = req.body;
    if (!cycleId) return res.status(400).json({ error: "cycleId is required" });
    if (!issue) return res.status(400).json({ error: "issue is required" });

    const [cycle] = await db
      .select({ id: cyclesTable.id, shortId: cyclesTable.shortId, trayPosition: cyclesTable.trayPosition })
      .from(cyclesTable)
      .where(eq(cyclesTable.id, cycleId))
      .limit(1);

    if (!cycle) return res.status(404).json({ error: "Cycle not found" });

    const totalTrays = (fullTrays ?? 1) + (halfTrays ?? 0);

    const [check] = await db
      .insert(manualChecksTable)
      .values({
        cycleId,
        fullTrays: fullTrays ?? 1,
        halfTrays: halfTrays ?? 0,
        isBadTrays: true,
        issue,
        notes: notes ?? null,
        photoUrls: [],
      })
      .returning();

    if (totalTrays >= HIGH_SEVERITY_THRESHOLD) {
      const location = cycle.trayPosition ?? `Cycle ${cycle.shortId}`;
      const alertTitle = `High Bad Tray Count: ${issue}`;
      await db
        .insert(alertsTable)
        .values({
          title: alertTitle,
          description: `${totalTrays} bad trays reported in ${location} due to "${issue}". Manual check logged for cycle ${cycle.shortId}.`,
          severity: "critical",
          location,
          status: "current",
        })
        .onConflictDoNothing();
    }

    return res.status(201).json({
      id: check.id,
      cycleId: check.cycleId,
      fullTrays: check.fullTrays,
      halfTrays: check.halfTrays,
      isBadTrays: check.isBadTrays,
      issue: check.issue ?? null,
      notes: check.notes ?? null,
      // Task 11 Step 4: sign the just-stored photo references before echoing
      // them to the client. (This is the only response path in this file that
      // returns photoUrls — the GET /bad-trays analysis `manualEntries` carry
      // none.) signMediaReferences([]) is a no-op when there are no photos.
      photoUrls: await signMediaReferences(check.photoUrls ?? []),
      createdBy: check.userId ?? null,
      createdAt: check.createdAt.toISOString(),
    });
  } catch (err) {
    req.log.error(err);
    return res.status(500).json({ error: "Failed to create bad tray entry" });
  }
});

export default router;
