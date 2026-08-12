// artifacts/api-server/src/tests/db/ssl.test.ts
//
// Guards the durable fix for the 2026-08-10 prod incident: a `sslmode` param in
// DATABASE_URL made node-postgres silently ignore buildSslConfig's CA-pinned
// `ssl` object, so pg verified against the system trust store (no Supabase Root
// 2021 CA) and every DB connection failed with "self-signed certificate in
// certificate chain" — a ~34h outage. buildPoolConfig must strip `sslmode` so
// the pinned CA always reaches the socket. Lives in the api-server suite because
// that's the runner wired into CI; imports @workspace/db/ssl (type-only pg dep,
// no DATABASE_URL needed).
import { describe, test, before, after } from "node:test";
import { equal, deepEqual } from "node:assert/strict";
import { stripSslmode, buildPoolConfig } from "@workspace/db/ssl";

describe("stripSslmode", () => {
  test("removes a trailing sslmode param", () => {
    equal(
      stripSslmode(
        "postgres://u:p@h.pooler.supabase.com:6543/postgres?sslmode=require",
      ),
      "postgres://u:p@h.pooler.supabase.com:6543/postgres",
    );
  });

  test("passes through a URL with no query string", () => {
    equal(
      stripSslmode("postgres://u:p@h:6543/postgres"),
      "postgres://u:p@h:6543/postgres",
    );
  });

  test("keeps other params, drops only sslmode (either order)", () => {
    equal(
      stripSslmode(
        "postgres://u:p@h:6543/postgres?sslmode=require&application_name=api",
      ),
      "postgres://u:p@h:6543/postgres?application_name=api",
    );
    equal(
      stripSslmode(
        "postgres://u:p@h:6543/postgres?application_name=api&sslmode=verify-full",
      ),
      "postgres://u:p@h:6543/postgres?application_name=api",
    );
  });

  test("is case-insensitive", () => {
    equal(
      stripSslmode("postgres://u:p@h:6543/postgres?SSLmode=require"),
      "postgres://u:p@h:6543/postgres",
    );
  });
});

describe("buildPoolConfig", () => {
  const prevCa = process.env.DATABASE_CA_CERT;
  before(() => {
    process.env.DATABASE_CA_CERT = "TEST-ROOT-CA-PEM";
  });
  after(() => {
    if (prevCa === undefined) delete process.env.DATABASE_CA_CERT;
    else process.env.DATABASE_CA_CERT = prevCa;
  });

  // The exact regression this fix exists to prevent: a remote URL carrying
  // `sslmode` must still end up with the CA-pinned ssl object AND a connection
  // string pg can't use to override it.
  test("remote URL with sslmode: CA-pinned ssl survives AND sslmode is stripped", () => {
    const { connectionString, ssl } = buildPoolConfig(
      "postgres://app:pw@db.pooler.supabase.com:6543/postgres?sslmode=require",
    );
    equal(
      connectionString,
      "postgres://app:pw@db.pooler.supabase.com:6543/postgres",
    );
    deepEqual(ssl, { ca: "TEST-ROOT-CA-PEM", rejectUnauthorized: true });
  });

  test("local URL stays ssl:false and is still stripped", () => {
    const { connectionString, ssl } = buildPoolConfig(
      "postgres://postgres:postgres@localhost:5432/postgres?sslmode=disable",
    );
    equal(
      connectionString,
      "postgres://postgres:postgres@localhost:5432/postgres",
    );
    equal(ssl, false);
  });
});
