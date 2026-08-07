import { describe, test } from "node:test";
import { strictEqual } from "node:assert";
import { requireRole } from "./requireRole";
import type { Request, Response } from "express";

function run(tenant: unknown, allowed: Array<"owner" | "admin" | "technician">) {
  const req = { tenant } as Request;
  let statusCode: number | undefined;
  let body: unknown;
  const res = {
    status(c: number) { statusCode = c; return this; },
    json(b: unknown) { body = b; return this; },
  } as unknown as Response;
  let nextCalled = false;
  requireRole(...allowed)(req, res, () => { nextCalled = true; });
  return { statusCode, body, nextCalled };
}

describe("requireRole", () => {
  test("allows an owner when owner|admin allowed", () => {
    const r = run({ organizationId: 1, facilityId: 1, role: "owner" }, ["owner", "admin"]);
    strictEqual(r.nextCalled, true);
  });
  test("403 ROLE_FORBIDDEN for a technician on an owner|admin route", () => {
    const r = run({ organizationId: 1, facilityId: 1, role: "technician" }, ["owner", "admin"]);
    strictEqual(r.statusCode, 403);
    strictEqual(r.nextCalled, false);
    strictEqual((r.body as { code: string }).code, "ROLE_FORBIDDEN");
  });
  test("403 when req.tenant is unset", () => {
    const r = run(undefined, ["owner", "admin"]);
    strictEqual(r.statusCode, 403);
    strictEqual(r.nextCalled, false);
  });
});
