import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { db, withTenantScope } from "@workspace/db";
import {
  usersTable,
  facilitiesTable,
  facilityReadinessEventsTable,
  sensorsTable,
  cyclesTable,
  accountingConnectionsTable,
} from "@workspace/db";
import { eq, and, isNull, count } from "drizzle-orm";
import { getAuth } from "../middlewares/supabaseAuth";

const router = Router();

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

async function getFacilityForUser(userId: string) {
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
  if (!user?.organizationId) return null;
  const [facility] = await db
    .select()
    .from(facilitiesTable)
    .where(eq(facilitiesTable.organizationId, user.organizationId));
  return facility ?? null;
}

// GET /facility-readiness — computed 7-item onboarding checklist (CHK-001..003).
//
// completedCount is derived BY CONSTRUCTION from filtering the exact `items`
// array returned in the response body, not computed independently and then
// compared — that is the only way the two numbers can never diverge. Do not
// "optimize" this into two separate tallies.
router.get("/facility-readiness", async (req: Request, res: Response) => {
  try {
    const { userId } = getAuth(req);
    const facility = await getFacilityForUser(userId!);
    if (!facility) return res.status(409).json({ error: "No facility yet" });

    const events = await db
      .select()
      .from(facilityReadinessEventsTable)
      .where(eq(facilityReadinessEventsTable.facilityId, facility.id));

    const activeEvent = (key: string) => events.find((e) => e.eventKey === key && !e.undoneAt);

    // Items 4 and 5 (first_cycle_seeded / sensors_registered): cyclesTable
    // and sensorsTable both gained a direct facilityId column in this same
    // milestone's route sweep (Tasks 4-8) -- the "neither has a direct
    // facilityId column" reasoning this comment used to have is stale.
    // Scoped directly by facility.id below, plus withTenantScope so RLS
    // (facility-scoped on both tables) actually admits the rows -- without
    // it, this connection never sets app.facility_id and every count here
    // silently reads as zero under a real non-BYPASSRLS role (found during
    // MT-M1's final review). accountingConnectionsTable is
    // organization-scoped (RLS requires app.org_id), same reasoning.
    const { sensorCount, cycleCount, qboConnection } = await withTenantScope(
      { organizationId: facility.organizationId, facilityId: facility.id },
      async (tx) => {
        const [{ sensorCount }] = await tx
          .select({ sensorCount: count() })
          .from(sensorsTable)
          .where(eq(sensorsTable.facilityId, facility.id));
        const [{ cycleCount }] = await tx
          .select({ cycleCount: count() })
          .from(cyclesTable)
          .where(eq(cyclesTable.facilityId, facility.id));
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
// event. Insert-or-update on the (facilityId, eventKey) unique constraint so
// a re-fired event just refreshes occurredAt / clears undoneAt rather than
// erroring or accumulating duplicate rows.
router.post("/facility-readiness/events", async (req: Request, res: Response) => {
  try {
    const { userId } = getAuth(req);
    const facility = await getFacilityForUser(userId!);
    if (!facility) return res.status(409).json({ error: "No facility yet" });

    const body = validate(ReadinessEventSchema, req.body, res);
    if (!body) return;

    if (body.undo) {
      await db
        .update(facilityReadinessEventsTable)
        .set({ undoneAt: new Date() })
        .where(
          and(
            eq(facilityReadinessEventsTable.facilityId, facility.id),
            eq(facilityReadinessEventsTable.eventKey, body.eventKey),
            isNull(facilityReadinessEventsTable.undoneAt),
          ),
        );
      return res.status(200).json({ ok: true });
    }

    await db
      .insert(facilityReadinessEventsTable)
      .values({ facilityId: facility.id, eventKey: body.eventKey })
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
