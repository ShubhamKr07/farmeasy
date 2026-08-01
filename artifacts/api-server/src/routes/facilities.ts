import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { db } from "@workspace/db";
import { organizationsTable, facilitiesTable, roomsTable, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { getAuth } from "../middlewares/supabaseAuth";

const router = Router();

const CreateFacilitySchema = z.object({
  farmName: z.string().min(1),
  facilityName: z.string().min(1).optional(),
  timezone: z.string().min(1),
  units: z.enum(["metric", "imperial"]),
  currency: z.string().length(3),
});

function validate<T>(schema: z.ZodSchema<T>, data: unknown, res: Response): T | null {
  const result = schema.safeParse(data);
  if (!result.success) {
    res.status(400).json({ error: "Validation failed", details: result.error.flatten() });
    return null;
  }
  return result.data;
}

// Sentinel thrown inside the transaction when the locking read finds the
// user already has an organization. Thrown (rather than returned) so
// db.transaction rolls back cleanly; caught outside and mapped to 409.
class AlreadyHasFacilityError extends Error {}

// POST /facilities — W2 farm-basics submit (WIZ-001/TEN-001/TEN-003).
// Creates an organization, its first facility, and the 3 index-1 rooms
// (seeding/fertigation/harvesting) in a single transaction, then assigns the
// signed-in user to the new organization. One facility per user is enforced
// here (usersTable.organizationId already set -> 409) even though the schema
// itself permits multiple facilities per organization.
//
// The existence check runs as a `SELECT ... FOR UPDATE` INSIDE this
// transaction (not a plain read beforehand) so two near-simultaneous POSTs
// from the same brand-new user serialize on the user row instead of racing:
// without the lock, both requests could observe organizationId as null
// before either commits, both proceed to create their own
// organization+facility+3 rooms, and whichever UPDATE users commits last
// wins — leaving the other transaction's rows fully committed but orphaned
// (unreachable from that user's organizationId). With the lock, the second
// request blocks until the first's transaction commits, then sees the
// now-set organizationId and cleanly rejects with 409 instead.
router.post("/facilities", async (req: Request, res: Response) => {
  try {
    const { userId } = getAuth(req);

    const body = validate(CreateFacilitySchema, req.body, res);
    if (!body) return;

    const result = await db.transaction(async (tx) => {
      const [existingUser] = await tx
        .select()
        .from(usersTable)
        .where(eq(usersTable.id, userId!))
        .for("update");
      if (existingUser?.organizationId) {
        throw new AlreadyHasFacilityError();
      }

      const [org] = await tx
        .insert(organizationsTable)
        .values({ name: body.farmName })
        .returning();
      const [facility] = await tx
        .insert(facilitiesTable)
        .values({
          name: body.farmName,
          organizationId: org.id,
          facilityName: body.facilityName || body.farmName,
          timezone: body.timezone,
          units: body.units,
          currency: body.currency,
        })
        .returning();
      await tx.insert(roomsTable).values([
        { name: "seeding", sortOrder: 0, facilityId: facility.id },
        { name: "fertigation", sortOrder: 1, facilityId: facility.id },
        { name: "harvesting", sortOrder: 2, facilityId: facility.id },
      ]);
      await tx
        .update(usersTable)
        .set({ organizationId: org.id })
        .where(eq(usersTable.id, userId!));
      return { facilityId: facility.id, organizationId: org.id };
    });

    return res.status(201).json(result);
  } catch (err) {
    if (err instanceof AlreadyHasFacilityError) {
      return res.status(409).json({ error: "User already belongs to a facility" });
    }
    req.log.error(err);
    return res.status(500).json({ error: "Failed to create facility" });
  }
});

// GET /facilities/me — facility-existence check used by the wizard gate
// (Task 4) to decide whether a signed-in user should be routed into the
// onboarding wizard or straight to the app.
router.get("/facilities/me", async (req: Request, res: Response) => {
  try {
    const { userId } = getAuth(req);
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId!));
    if (!user?.organizationId) return res.status(200).json(null);
    const [facility] = await db
      .select()
      .from(facilitiesTable)
      .where(eq(facilitiesTable.organizationId, user.organizationId));
    return res.status(200).json(facility ?? null);
  } catch (err) {
    req.log.error(err);
    return res.status(500).json({ error: "Failed to fetch facility" });
  }
});

export default router;
