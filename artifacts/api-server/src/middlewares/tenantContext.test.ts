// artifacts/api-server/src/middlewares/tenantContext.test.ts
import { describe, test } from "node:test";
import { strictEqual } from "node:assert";
import { requireTenantContext } from "./tenantContext";
import type { Request, Response } from "express";

describe("requireTenantContext", () => {
  test("403s when req.tenant is unset", () => {
    const req = {} as Request;
    let statusCode: number | undefined;
    let body: unknown;
    const res = {
      status(code: number) {
        statusCode = code;
        return this;
      },
      json(b: unknown) {
        body = b;
        return this;
      },
    } as unknown as Response;
    let nextCalled = false;
    requireTenantContext(req, res, () => {
      nextCalled = true;
    });
    strictEqual(statusCode, 403);
    strictEqual(nextCalled, false);
    strictEqual((body as { error: string }).error, "No facility membership found");
  });

  test("calls next() when req.tenant is set", () => {
    const req = { tenant: { organizationId: 1, facilityId: 1, role: "owner" as const } } as Request;
    let nextCalled = false;
    requireTenantContext(req, {} as Response, () => {
      nextCalled = true;
    });
    strictEqual(nextCalled, true);
  });
});
