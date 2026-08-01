import { describe, test } from "node:test";
import { ok, strictEqual, deepStrictEqual } from "node:assert";
import request from "supertest";
import { Router } from "express";
import { createAuthenticatedTestApp, DEFAULT_TEST_USER } from "./testApp";
import {
  requireTestDatabaseUrl,
  useDatabaseFixture,
} from "./testDatabase";

/**
 * Smoke test for the authenticated route test harness (testApp.ts) and the DB
 * fixture helper (testDatabase.ts). Proves the wiring Tasks 5-9 will rely on:
 * JSON parsing, the supabaseUser double, router-under-`/api` mounting, a
 * custom user override, and a DB fixture that is a safe no-op when
 * TEST_DATABASE_URL is unset (the default local/CI state — it neither errors
 * nor hangs the run).
 *
 * The DB-backed parts gate on TEST_DATABASE_URL the same way the metrics
 * suites do, so this file runs green with no database present.
 */
describe("authenticated test harness", () => {
  describe("createAuthenticatedTestApp", () => {
    test("mounts router under /api and injects the default identity", async () => {
      const router = Router();
      router.get("/whoami", (req, res) => {
        res.json(req.supabaseUser ?? null);
      });
      const app = createAuthenticatedTestApp(router);

      const res = await request(app).get("/api/whoami");

      strictEqual(res.status, 200);
      deepStrictEqual(res.body, DEFAULT_TEST_USER);
    });

    test("honors a caller-supplied user override", async () => {
      const facilityLead = {
        sub: "00000000-0000-4000-8000-000000000002",
        user_role: "facility_lead",
      };
      const router = Router();
      router.get("/whoami", (req, res) => {
        res.json(req.supabaseUser ?? null);
      });
      const app = createAuthenticatedTestApp(router, facilityLead);

      const res = await request(app).get("/api/whoami");

      strictEqual(res.status, 200);
      deepStrictEqual(res.body, facilityLead);
    });

    test("parses JSON request bodies (mirrors app.ts)", async () => {
      const router = Router();
      router.post("/echo", (req, res) => {
        res.json({ got: req.body });
      });
      const app = createAuthenticatedTestApp(router);

      const res = await request(app)
        .post("/api/echo")
        .send({ harvested_qty: 42, note: "fixture" });

      strictEqual(res.status, 200);
      deepStrictEqual(res.body, { got: { harvested_qty: 42, note: "fixture" } });
    });
  });

  describe("useDatabaseFixture", () => {
    const url = requireTestDatabaseUrl();
    // Always register the fixture (even with no DB) to prove the helper's
    // TEST_DATABASE_URL guards make it a safe no-op in a database-less run —
    // the condition Tasks 5-9 inherit locally. The before/after hooks are
    // guarded, so with TEST_DATABASE_URL unset they neither truncate, open a
    // pool, nor (critically) leave one dangling to hang the process.
    const fixture = useDatabaseFixture([]);

    test("exposes the TEST_DATABASE_URL gate without erroring", () => {
      ok(fixture.url === url);
    });
  });
});
