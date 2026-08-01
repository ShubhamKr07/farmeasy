import { Router, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { db } from "@workspace/db";
import { sensorAccountsTable, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { getAuth } from "../middlewares/supabaseAuth";
import { encryptToken } from "../lib/accounting/crypto";

const router = Router();

const CreateSensorAccountSchema = z.object({
  vendor: z.string().min(1),
  authMethod: z.enum(["api_key", "oauth", "username_password"]),
  credential: z.string().min(1), // API key, or JSON-stringified username/password — encrypted before storage
});

function validate<T>(schema: z.ZodSchema<T>, data: unknown, res: Response): T | null {
  const result = schema.safeParse(data);
  if (!result.success) {
    res.status(400).json({ error: "Validation failed", details: result.error.flatten() });
    return null;
  }
  return result.data;
}

// GET /sensor-accounts — list the signed-in user's organization's vendor accounts.
// NEVER select credentialCiphertext (SEN-002) — explicit column list, not select-all.
router.get("/sensor-accounts", async (req: Request, res: Response) => {
  try {
    const { userId } = getAuth(req);
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId!));
    if (!user?.organizationId) return res.status(200).json([]);

    const accounts = await db
      .select({
        id: sensorAccountsTable.id,
        vendor: sensorAccountsTable.vendor,
        authMethod: sensorAccountsTable.authMethod,
        status: sensorAccountsTable.status,
        maskedFingerprint: sensorAccountsTable.maskedFingerprint,
        createdAt: sensorAccountsTable.createdAt,
      })
      .from(sensorAccountsTable)
      .where(eq(sensorAccountsTable.organizationId, user.organizationId));
    return res.status(200).json(accounts);
  } catch (err) {
    req.log.error(err);
    return res.status(500).json({ error: "Failed to list sensor accounts" });
  }
});

router.post("/sensor-accounts", async (req: Request, res: Response) => {
  try {
    const { userId } = getAuth(req);
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId!));
    if (!user?.organizationId) return res.status(409).json({ error: "No facility yet" });

    const body = validate(CreateSensorAccountSchema, req.body, res);
    if (!body) return;

    const masked = `····${body.credential.slice(-4)}`;
    const [account] = await db
      .insert(sensorAccountsTable)
      .values({
        organizationId: user.organizationId,
        vendor: body.vendor,
        authMethod: body.authMethod,
        status: "pending_integration",
        maskedFingerprint: masked,
        credentialCiphertext: encryptToken(body.credential),
      })
      .returning({
        id: sensorAccountsTable.id,
        vendor: sensorAccountsTable.vendor,
        authMethod: sensorAccountsTable.authMethod,
        status: sensorAccountsTable.status,
        maskedFingerprint: sensorAccountsTable.maskedFingerprint,
      });
    return res.status(201).json(account); // NEVER return credentialCiphertext or plaintext (SEN-002)
  } catch (err) {
    req.log.error(err);
    return res.status(500).json({ error: "Failed to create sensor account" });
  }
});

// Vendor allowlist: empty at launch — every vendor falls through to
// "pending_integration" with honest copy (SEN-003: never a fake "connected").
// Real per-vendor adapters get added here as they're built:
// `{ trolmaster: (credential: string) => Promise<boolean>, ... }`.
const VENDOR_ADAPTERS: Record<string, (credential: string) => Promise<boolean>> = {};

// Per-user rate limit on test-connection (per newly-established /recommend
// precedent, Release 1 Task 9): this will eventually call real third-party
// vendor APIs, and an unbounded client could hammer a vendor or rack up cost
// once real adapters exist. Every vendor is `pending_integration` today (the
// allowlist above is empty), so this is defense-in-depth ahead of need, not
// a load-bearing control yet — wired now so adding a real adapter later is a
// one-line change, not a forgotten follow-up. Process-local MemoryStore,
// same as recommend.ts (no horizontal API scaling until a shared store
// exists).
const TEST_CONNECTION_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const TEST_CONNECTION_RATE_LIMIT = 20;

const testConnectionLimiter = rateLimit({
  windowMs: TEST_CONNECTION_RATE_LIMIT_WINDOW_MS,
  limit: TEST_CONNECTION_RATE_LIMIT,
  keyGenerator: (req) => getAuth(req).userId ?? "anon",
  handler: (_req, res) => {
    res.status(429).json({
      error: "Too many connection tests for this user. Please try again later.",
    });
  },
  legacyHeaders: false,
});

router.post(
  "/sensor-accounts/:id/test-connection",
  testConnectionLimiter,
  async (req: Request, res: Response) => {
    try {
      const { userId } = getAuth(req);
      const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId!));
      if (!user?.organizationId) return res.status(409).json({ error: "No facility yet" });

      const id = Number(req.params.id);
      const [account] = await db
        .select()
        .from(sensorAccountsTable)
        .where(eq(sensorAccountsTable.id, id));
      if (!account || account.organizationId !== user.organizationId) {
        return res.status(404).json({ error: "Sensor account not found" });
      }

      const adapter = VENDOR_ADAPTERS[account.vendor.toLowerCase()];
      if (!adapter) {
        // No adapter for this vendor yet — honest "pending_integration", never a fake success.
        await db
          .update(sensorAccountsTable)
          .set({ status: "pending_integration", updatedAt: new Date() })
          .where(eq(sensorAccountsTable.id, id));
        return res.status(200).json({ status: "pending_integration" });
      }

      try {
        const { decryptToken } = await import("../lib/accounting/crypto");
        const credential = decryptToken(account.credentialCiphertext!);
        const connected = await adapter(credential);
        const status = connected ? "connected" : "failed";
        await db
          .update(sensorAccountsTable)
          .set({ status, updatedAt: new Date() })
          .where(eq(sensorAccountsTable.id, id));
        return res.status(200).json({ status });
      } catch (adapterErr) {
        req.log.error(adapterErr);
        await db
          .update(sensorAccountsTable)
          .set({ status: "failed", updatedAt: new Date() })
          .where(eq(sensorAccountsTable.id, id));
        return res.status(200).json({ status: "failed" });
      }
    } catch (err) {
      req.log.error(err);
      return res.status(500).json({ error: "Failed to test connection" });
    }
  },
);

export default router;
