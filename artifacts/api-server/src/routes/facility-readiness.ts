import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { db, withTenantScope } from "@workspace/db";
import {
  facilityReadinessEventsTable,
  sensorsTable,
  cyclesTable,
  accountingConnectionsTable,
} from "@workspace/db";
import { eq, and, isNull, count } from "drizzle-orm";
import { getAuth } from "../middlewares/supabaseAuth";
import { requireTenantContext } from "../middlewares/tenantContext";

const router = Router();
router.use(requireTenantContext);

const ReadinessEventSchema = z.object({
  eventKey: z.enum([
    "labels_downloaded",
    "labels_scanned",
    "grow_profile_created",
    "seeds_added",
    "first_cycle_seeded",
    "sensors_skipped",
    "quickbooks_skipped",
    "team_invited",
  ]),
  undo: z.boolean().optional(),
});

function validate<T>(schema: z.ZodSchema<T>, data: unknown, res: Response): T | null {
  const result = schema.safeParse(data);
  if (!result.success) {
    res.status(400).json({ error: "Validation failed", details: result.error.flatten() });
    return null;
  }
  return result.data;
}

// GET /facility-readiness — computed 7-item onboarding checklist (CHK-001..003),
// scoped to req.tenant.facilityId (TEN-008: each facility runs its own
// checklist, per the PRD's literal text — this used to resolve "the org's
// one facility" via getFacilityForUser, which silently picked an arbitrary
// facility once an org could hold more than one).
//
// completedCount is derived BY CONSTRUCTION from filtering the exact `items`
// array returned in the response body, not computed independently and then
// compared — that is the only way the two numbers can never diverge. Do not
// "optimize" this into two separate tallies.
router.get("/facility-readiness", async (req: Request, res: Response) => {
  try {
    const { userId } = getAuth(req);
    const { organizationId, facilityId } = req.tenant!;

    const events = await db
      .select()
      .from(facilityReadinessEventsTable)
      .where(eq(facilityReadinessEventsTable.facilityId, facilityId));

    const activeEvent = (key: string) => events.find((e) => e.eventKey === key && !e.undoneAt);

    const { sensorCount, cycleCount, qboConnection } = await withTenantScope(
      { organizationId, facilityId },
      async (tx) => {
        const [{ sensorCount }] = await tx
          .select({ sensorCount: count() })
          .from(sensorsTable)
          .where(eq(sensorsTable.facilityId, facilityId));
        const [{ cycleCount }] = await tx
          .select({ cycleCount: count() })
          .from(cyclesTable)
          .where(eq(cyclesTable.facilityId, facilityId));
        const [qboConnection] = await tx
          .select()
          .from(accountingConnectionsTable)
          .where(
            and(eq(accountingConnectionsTable.userId, userId!), eq(accountingConnectionsTable.provider, "quickbooks")),
          );
        return { sensorCount, cycleCount, qboConnection };
      },
    );

    const labelsDownloaded = activeEvent("labels_downloaded");
    const labelsScanned = activeEvent("labels_scanned");
    const labelsState = labelsScanned ? "done" : labelsDownloaded ? "interim" : "pending";

    const sensorsSkipped = activeEvent("sensors_skipped");
    const sensorsState = sensorsSkipped ? "skipped" : sensorCount > 0 ? "done" : "pending";

    const qboSkipped = activeEvent("quickbooks_skipped");
    const qboState = qboConnection ? "done" : qboSkipped ? "skipped" : "pending";

    const items = [
      { key: "labels_downloaded", label: "Print level QR labels", state: labelsState, deepLink: "/layout" },
      {
        key: "grow_profile_created",
        label: "Create a grow profile",
        state: activeEvent("grow_profile_created") ? "done" : "pending",
        deepLink: "/profiles",
      },
      {
        key: "seeds_added",
        label: "Add seeds with QR",
        state: activeEvent("seeds_added") ? "done" : "pending",
        deepLink: "/inventory?category=Seeds",
      },
      {
        key: "first_cycle_seeded",
        label: "Seed your first cycle",
        state: cycleCount > 0 ? "done" : "pending",
        deepLink: null,
      },
      { key: "sensors_registered", label: "Register sensors", state: sensorsState, count: sensorCount },
      { key: "quickbooks_connected", label: "Connect QuickBooks", state: qboState, deepLink: null },
      {
        key: "team_invited",
        label: "Invite your team",
        state: activeEvent("team_invited") ? "done" : "pending",
        deepLink: "/settings",
      },
    ];

    const completedCount = items.filter((i) => i.state === "done").length;

    return res.status(200).json({ items, completedCount });
  } catch (err) {
    req.log.error(err);
    return res.status(500).json({ error: "Failed to fetch facility readiness" });
  }
});

// POST /facility-readiness/events — record (or undo) a checklist-relevant
// event, scoped to req.tenant.facilityId (TEN-008 — same reasoning as GET
// above).
router.post("/facility-readiness/events", async (req: Request, res: Response) => {
  try {
    const { facilityId } = req.tenant!;

    const body = validate(ReadinessEventSchema, req.body, res);
    if (!body) return;

    if (body.undo) {
      await db
        .update(facilityReadinessEventsTable)
        .set({ undoneAt: new Date() })
        .where(
          and(
            eq(facilityReadinessEventsTable.facilityId, facilityId),
            eq(facilityReadinessEventsTable.eventKey, body.eventKey),
            isNull(facilityReadinessEventsTable.undoneAt),
          ),
        );
      return res.status(200).json({ ok: true });
    }

    await db
      .insert(facilityReadinessEventsTable)
      .values({ facilityId, eventKey: body.eventKey })
      .onConflictDoUpdate({
        target: [facilityReadinessEventsTable.facilityId, facilityReadinessEventsTable.eventKey],
        set: { occurredAt: new Date(), undoneAt: null },
      });
    return res.status(201).json({ ok: true });
  } catch (err) {
    req.log.error(err);
    return res.status(500).json({ error: "Failed to record readiness event" });
  }
});

export default router;
