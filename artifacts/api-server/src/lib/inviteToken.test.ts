import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateInviteToken, hashInviteToken } from "./inviteToken.js";

describe("inviteToken", () => {
  it("generates a raw token and its matching hash", () => {
    const { raw, hash } = generateInviteToken();
    assert.match(raw, /^[A-Za-z0-9_-]{20,}$/); // base64url, no padding
    assert.strictEqual(hash, hashInviteToken(raw));
  });

  it("hashInviteToken is deterministic and 64 hex chars (sha256)", () => {
    const h1 = hashInviteToken("abc");
    const h2 = hashInviteToken("abc");
    assert.strictEqual(h1, h2);
    assert.match(h1, /^[0-9a-f]{64}$/);
  });

  it("different raw tokens hash differently", () => {
    const a = generateInviteToken();
    const b = generateInviteToken();
    assert.notStrictEqual(a.raw, b.raw);
    assert.notStrictEqual(a.hash, b.hash);
  });
});
