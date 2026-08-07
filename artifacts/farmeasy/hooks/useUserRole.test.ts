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
  it("returns the custom user_role claim when present (owner)", async () => {
    claimsResult = { data: { claims: { user_role: "owner" } }, error: null };
    assert.equal(await getUserRole(), "owner");
  });

  it("returns admin and technician claims verbatim", async () => {
    claimsResult = { data: { claims: { user_role: "admin" } }, error: null };
    assert.equal(await getUserRole(), "admin");

    claimsResult = { data: { claims: { user_role: "technician" } }, error: null };
    assert.equal(await getUserRole(), "technician");
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
