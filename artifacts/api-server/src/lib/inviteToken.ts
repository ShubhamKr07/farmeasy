import { randomBytes, createHash } from "node:crypto";

/** SHA-256 hex of a raw invite token — what we store at rest. */
export function hashInviteToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/**
 * A fresh invite token: 32 random bytes as base64url (URL-fragment-safe, no
 * padding) plus its SHA-256 hash. The raw value is emailed (in the link
 * fragment) and never stored; only the hash is persisted.
 */
export function generateInviteToken(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString("base64url");
  return { raw, hash: hashInviteToken(raw) };
}
