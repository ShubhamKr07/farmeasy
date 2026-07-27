import { Router, type Request, type Response } from "express";
import { getAuth } from "../middlewares/supabaseAuth";
import { eq, and } from "drizzle-orm";
import { db, userSettingsTable } from "@workspace/db";

const router = Router();

/**
 * Per-user settings (metric selection, card order, etc.), keyed by an
 * arbitrary string `key` per row. Backs useMetricSelection's persistence
 * (M4) — replaces localStorage as the source of truth, with localStorage
 * kept as an instant-write cache.
 */

router.get("/users/me/settings", async (req: Request, res: Response) => {
  const { userId } = getAuth(req);
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const rows = await db
    .select({ key: userSettingsTable.key, value: userSettingsTable.value })
    .from(userSettingsTable)
    .where(eq(userSettingsTable.userId, userId));

  const settings: Record<string, unknown> = {};
  for (const r of rows) settings[r.key] = r.value;
  return res.json({ settings });
});

router.put("/users/me/settings/:key", async (req: Request, res: Response) => {
  const { userId } = getAuth(req);
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const key = String(req.params.key);
  const { value } = req.body as { value?: unknown };
  if (value === undefined) {
    return res.status(400).json({ error: "value is required" });
  }

  await db
    .insert(userSettingsTable)
    .values({ userId: userId, key, value: value as object, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [userSettingsTable.userId, userSettingsTable.key],
      set: { value: value as object, updatedAt: new Date() },
    });

  return res.json({ key, value });
});

export default router;
