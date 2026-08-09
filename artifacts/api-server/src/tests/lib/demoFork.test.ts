import { describe, test, afterEach } from "node:test";
import { strictEqual } from "node:assert";
import { isDemoForkEnabled } from "../../lib/demoFork.js";

describe("isDemoForkEnabled", () => {
  const orig = process.env.DEMO_FORK_ENABLED;
  afterEach(() => {
    if (orig === undefined) delete process.env.DEMO_FORK_ENABLED;
    else process.env.DEMO_FORK_ENABLED = orig;
  });

  test("defaults to false when unset", () => {
    delete process.env.DEMO_FORK_ENABLED;
    strictEqual(isDemoForkEnabled(), false);
  });
  test("is false for any non-'true' value", () => {
    process.env.DEMO_FORK_ENABLED = "1";
    strictEqual(isDemoForkEnabled(), false);
    process.env.DEMO_FORK_ENABLED = "yes";
    strictEqual(isDemoForkEnabled(), false);
  });
  test("is true only for 'true' (case-insensitive)", () => {
    process.env.DEMO_FORK_ENABLED = "TRUE";
    strictEqual(isDemoForkEnabled(), true);
    process.env.DEMO_FORK_ENABLED = "true";
    strictEqual(isDemoForkEnabled(), true);
  });
});
