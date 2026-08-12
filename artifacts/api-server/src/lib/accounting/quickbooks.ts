import OAuthClient from "intuit-oauth";
import { eq, and } from "drizzle-orm";
import { accountingConnectionsTable, withTenantScope, type TenantContext } from "@workspace/db";
import { encryptToken, decryptToken } from "./crypto";

/**
 * QuickBooks Online OAuth + API helpers. One connection per (user_id,
 * provider) — enforced by accounting_connections' unique index.
 *
 * Env required: QBO_CLIENT_ID, QBO_CLIENT_SECRET, QBO_REDIRECT_URI,
 * QBO_ENVIRONMENT ("sandbox" | "production", default sandbox),
 * ACCOUNTING_ENCRYPTION_KEY (see crypto.ts).
 *
 * accounting_connections is organization-scoped RLS (00007) -- every
 * function below wraps its DB access in withTenantScope so app.org_id is
 * actually set. Without it (found during MT-M1's final review), this table's
 * RLS policy can never admit a row under a real non-BYPASSRLS role: the
 * OAuth callback's INSERT would fail its WITH CHECK, meaning a QuickBooks
 * connection could never be saved at all, and every other lookup here would
 * silently see "not connected" regardless of what's actually stored.
 */

const QBO_ENV = (process.env.QBO_ENVIRONMENT === "production" ? "production" : "sandbox") as
  | "sandbox"
  | "production";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} environment variable is required`);
  return v;
}

export function createOAuthClient(): OAuthClient {
  return new OAuthClient({
    clientId: requireEnv("QBO_CLIENT_ID"),
    clientSecret: requireEnv("QBO_CLIENT_SECRET"),
    environment: QBO_ENV,
    redirectUri: requireEnv("QBO_REDIRECT_URI"),
  });
}

export function getAuthorizeUri(state: string): string {
  const client = createOAuthClient();
  return client.authorizeUri({
    scope: [OAuthClient.scopes.Accounting],
    state,
  });
}

interface StoredConnection {
  id: number;
  realmId: string;
  companyName: string | null;
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getConnectionRow(tx: any, userId: string, organizationId: number) {
  const [row] = await tx
    .select()
    .from(accountingConnectionsTable)
    .where(
      and(
        eq(accountingConnectionsTable.userId, userId),
        eq(accountingConnectionsTable.provider, "quickbooks"),
        eq(accountingConnectionsTable.organizationId, organizationId),
      ),
    )
    .limit(1);
  return row;
}

export async function saveConnectionFromCallback(
  userId: string,
  organizationId: number,
  callbackUrl: string,
): Promise<{ realmId: string }> {
  const client = createOAuthClient();
  const authResponse = await client.createToken(callbackUrl);
  const token = authResponse.getToken();

  if (!token.realmId || !token.access_token || !token.refresh_token) {
    throw new Error("QuickBooks callback did not return a complete token");
  }
  // Narrowed to plain const locals: TS's control-flow narrowing on
  // token.access_token/refresh_token above doesn't persist into the
  // withTenantScope callback below (a closure boundary loses narrowing on
  // property access, even though `token` itself is never reassigned).
  const realmId = token.realmId;
  const accessToken = token.access_token;
  const refreshToken = token.refresh_token;

  const expiresAt = new Date(Date.now() + (token.expires_in ?? 3600) * 1000);

  const ctx: TenantContext = { organizationId };
  await withTenantScope(ctx, (tx) =>
    tx
      .insert(accountingConnectionsTable)
      .values({
        userId,
        organizationId,
        provider: "quickbooks",
        realmId,
        accessTokenEnc: encryptToken(accessToken),
        refreshTokenEnc: encryptToken(refreshToken),
        expiresAt,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [accountingConnectionsTable.userId, accountingConnectionsTable.provider],
        set: {
          realmId,
          accessTokenEnc: encryptToken(accessToken),
          refreshTokenEnc: encryptToken(refreshToken),
          expiresAt,
          updatedAt: new Date(),
        },
      }),
  );

  return { realmId };
}

export async function getConnectionStatus(userId: string, organizationId: number) {
  const ctx: TenantContext = { organizationId };
  const row = await withTenantScope(ctx, (tx) => getConnectionRow(tx, userId, organizationId));
  if (!row) return { connected: false as const };
  return {
    connected: true as const,
    realmId: row.realmId,
    companyName: row.companyName,
    environment: QBO_ENV,
  };
}

export async function disconnect(userId: string, organizationId: number): Promise<boolean> {
  const ctx: TenantContext = { organizationId };
  return withTenantScope(ctx, async (tx) => {
    const row = await getConnectionRow(tx, userId, organizationId);
    if (!row) return false;

    try {
      const client = createOAuthClient();
      client.setToken({ refresh_token: decryptToken(row.refreshTokenEnc) });
      await client.revoke();
    } catch {
      // Best-effort revoke with Intuit; proceed to delete our record regardless.
    }

    await tx.delete(accountingConnectionsTable).where(eq(accountingConnectionsTable.id, row.id));
    return true;
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function persistRefreshedToken(
  tx: any,
  connectionId: number,
  client: OAuthClient,
  fallbackRefreshToken: string,
): Promise<void> {
  const token = client.getToken();
  const expiresAt = new Date(Date.now() + (token.expires_in ?? 3600) * 1000);
  await tx
    .update(accountingConnectionsTable)
    .set({
      accessTokenEnc: encryptToken(token.access_token!),
      refreshTokenEnc: encryptToken(token.refresh_token ?? fallbackRefreshToken),
      expiresAt,
      updatedAt: new Date(),
    })
    .where(eq(accountingConnectionsTable.id, connectionId));
}

/**
 * Returns a ready-to-use OAuthClient (valid access token, refreshing first if
 * expired) plus the realmId, for a given user. Throws if not connected.
 */
export async function getAuthenticatedClient(
  userId: string,
  organizationId: number,
): Promise<{ client: OAuthClient; realmId: string }> {
  const ctx: TenantContext = { organizationId };
  return withTenantScope(ctx, async (tx) => {
    const row = await getConnectionRow(tx, userId, organizationId);
    if (!row) throw new Error("QuickBooks is not connected for this user");

    const client = createOAuthClient();
    const accessToken = decryptToken(row.accessTokenEnc);
    const refreshToken = decryptToken(row.refreshTokenEnc);
    client.setToken({
      access_token: accessToken,
      refresh_token: refreshToken,
      realmId: row.realmId,
    });

    const needsRefresh = row.expiresAt.getTime() <= Date.now() + 60_000; // refresh 1 min early
    if (needsRefresh) {
      await client.refresh();
      await persistRefreshedToken(tx, row.id, client, refreshToken);
    }

    return { client, realmId: row.realmId };
  });
}

/** True for the specific "access token rejected by QuickBooks" signal (intuit-oauth's OAuthError with .code "401"), never for other error shapes (429 rate limit, 5xx, network, validation, ...). */
export function isUnauthorizedError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    String((err as { code: unknown }).code) === "401"
  );
}

/**
 * Runs `apiCall` once; on a 401 (per `isUnauthorized`), runs `refresh` and,
 * if it reports success, retries `apiCall` exactly once more -- whatever that
 * retry does (succeed or throw) is final. `refresh` reporting failure
 * surfaces the ORIGINAL 401 immediately, without a second `apiCall` attempt.
 * Either way this makes at most ONE refresh attempt and at most ONE retry --
 * the explicit ACC-004 cap against hammering QuickBooks' rate limits on a
 * truly-expired connection. Decoupled from the real OAuthClient/DB plumbing
 * (see `callWithReactiveRefresh` below) so this cap is unit-testable without
 * live QuickBooks credentials.
 */
export async function runWithOneRefreshRetry<T>(
  apiCall: () => Promise<T>,
  refresh: () => Promise<boolean>,
  isUnauthorized: (err: unknown) => boolean = isUnauthorizedError,
): Promise<T> {
  try {
    return await apiCall();
  } catch (err) {
    if (!isUnauthorized(err)) throw err;
    const refreshed = await refresh();
    if (!refreshed) throw err;
    return await apiCall();
  }
}

/**
 * Silently refreshes and persists a new access/refresh token pair for
 * (userId, organizationId). Never throws -- returns false on ANY failure
 * (client.refresh() rejecting, the connection having vanished mid-flight,
 * a DB error), which `runWithOneRefreshRetry` treats as "give up, surface
 * the original 401" rather than letting a refresh-side error mask it.
 */
async function attemptSilentRefresh(
  userId: string,
  organizationId: number,
  client: OAuthClient,
): Promise<boolean> {
  const ctx: TenantContext = { organizationId };
  try {
    await withTenantScope(ctx, async (tx) => {
      const row = await getConnectionRow(tx, userId, organizationId);
      if (!row) throw new Error("QuickBooks connection no longer exists");
      await client.refresh();
      await persistRefreshedToken(tx, row.id, client, decryptToken(row.refreshTokenEnc));
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Real-world wiring for ACC-004: gets an authenticated client (with the
 * existing proactive expiry-based refresh) and runs `apiCall` against it,
 * attempting exactly one silent reactive refresh + retry if QuickBooks
 * itself rejects the access token with a 401 (e.g. revoked externally, or
 * clock skew past our own `expiresAt` bookkeeping). A recoverable 401 is
 * invisible to the caller; an unrecoverable one still throws after the
 * single retry -- routes/metrics.ts turns that into a per-key error message
 * that Accounting.tsx (ACC-001/002/003) turns into the expired-connection
 * banner.
 */
export async function callWithReactiveRefresh<T>(
  userId: string,
  organizationId: number,
  apiCall: (client: OAuthClient, realmId: string) => Promise<T>,
): Promise<T> {
  const { client, realmId } = await getAuthenticatedClient(userId, organizationId);
  return runWithOneRefreshRetry(
    () => apiCall(client, realmId),
    () => attemptSilentRefresh(userId, organizationId, client),
  );
}

/** Cheap connectivity check for /api/metrics/availability — no token refresh. */
export async function isConnected(userId: string, organizationId: number): Promise<boolean> {
  const ctx: TenantContext = { organizationId };
  const row = await withTenantScope(ctx, (tx) => getConnectionRow(tx, userId, organizationId));
  return !!row;
}
