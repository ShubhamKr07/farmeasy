// lib/db/src/scope.test.ts
import { describe, test } from "node:test";
import { rejects } from "node:assert";
import { withTenantScope } from "./scope.js";

describe("withTenantScope", () => {
  test("throws synchronously when organizationId is missing", async () => {
    await rejects(
      () => withTenantScope({} as any, async () => "unreachable"),
      /organization context/,
    );
  });

  test("throws when ctx is null/undefined", async () => {
    await rejects(() => withTenantScope(null as any, async () => "unreachable"));
  });
});
