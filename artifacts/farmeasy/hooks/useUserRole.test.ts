import { describe, it, mock, before } from "node:test";
import assert from "node:assert/strict";

// Register the mock before any import of useUserRole pulls in @/lib/supabase.
// Requires --experimental-test-module-mocks (see scripts/run-tests.mjs).
let claimsResult: { data: { claims: Record<string, unknown> } | null; error: unknown };

mock.module("@/lib/supabase", {
  namedExports: {
    supabase: {
      auth: {
        async getClaims() {
          return claimsResult;
        },
      },
    },
  },
});

let getUserRole: () => Promise<string>;

before(async () => {
  const mod = await import("./useUserRole.js");
  getUserRole = mod.getUserRole;
});

describe("getUserRole", () => {
  it("returns the custom user_role claim when present", async () => {
    claimsResult = { data: { claims: { user_role: "supervisor" } }, error: null };
    assert.equal(await getUserRole(), "supervisor");
  });

  it("returns quality_lead and facility_lead claims verbatim", async () => {
    claimsResult = { data: { claims: { user_role: "quality_lead" } }, error: null };
    assert.equal(await getUserRole(), "quality_lead");

    claimsResult = { data: { claims: { user_role: "facility_lead" } }, error: null };
    assert.equal(await getUserRole(), "facility_lead");
  });

  it("defaults to technician when the claim is absent", async () => {
    claimsResult = { data: { claims: {} }, error: null };
    assert.equal(await getUserRole(), "technician");
  });

  it("defaults to technician when claims data is null", async () => {
    claimsResult = { data: null, error: null };
    assert.equal(await getUserRole(), "technician");
  });

  it("throws when getClaims() returns an error", async () => {
    claimsResult = { data: null, error: new Error("invalid session") };
    await assert.rejects(() => getUserRole(), /invalid session/);
  });
});
