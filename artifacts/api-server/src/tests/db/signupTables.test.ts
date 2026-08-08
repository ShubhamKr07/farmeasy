import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getAdminDb } from "../helpers/testDatabase.js";

const admin = getAdminDb();
describe("TEN-012 signup tables", { skip: !admin }, () => {
  it("signup_allowlist enforces unique email", async () => {
    const { signupAllowlistTable } = await import("@workspace/db");
    await admin!.insert(signupAllowlistTable).values({ email: "t1@example.com" });
    await assert.rejects(admin!.insert(signupAllowlistTable).values({ email: "t1@example.com" }));
  });
  it("access_requests + purge audit accept rows", async () => {
    const { accessRequestsTable, accountPurgeAuditTable } = await import("@workspace/db");
    await admin!.insert(accessRequestsTable).values({ email: "w1@example.com", farmName: "W1 Farm" });
    await admin!.insert(accountPurgeAuditTable).values({
      userId: "00000000-0000-4000-8000-0000000000aa", email: "w1@example.com", action: "warned",
    });
  });
});
