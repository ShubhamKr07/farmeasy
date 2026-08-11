import type { Request, Response, NextFunction } from "express";
import { createClient } from "@supabase/supabase-js";
import { jwtVerify, createRemoteJWKSet } from "jose";

// Strip whitespace: Render env vars pasted line-wrapped embed a literal
// newline mid-value (see the same fix in admin-dashboard's supabase.ts). A
// newline in the `apikey`/`Authorization` header breaks every Supabase
// request; neither a URL nor a JWT legitimately contains whitespace.
const SUPABASE_URL = process.env.SUPABASE_URL!.replace(/\s/g, "");
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!.replace(/\s/g, "");

const JWKS = createRemoteJWKSet(
  new URL(`${SUPABASE_URL}/auth/v1/.well-known/jwks.json`),
);

export const supabaseAdmin = createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
);

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      supabaseUser?: { sub: string; user_role?: string; email?: string; emailVerified?: boolean };
    }
  }
}

// Pulls the email-verification boolean out of a verified GoTrue JWT payload.
// Primary location `user_metadata.email_verified`; top-level `email_verified`
// kept as a defensive fallback. Returns `undefined` when the claim is absent
// so callers can fail-open on absence (see requireVerifiedEmail.ts).
function extractEmailVerified(payload: Record<string, unknown>): boolean | undefined {
  const meta = payload.user_metadata as Record<string, unknown> | undefined;
  const fromMeta = meta?.email_verified;
  if (typeof fromMeta === "boolean") return fromMeta;
  const topLevel = payload.email_verified;
  if (typeof topLevel === "boolean") return topLevel;
  return undefined;
}

export async function supabaseAuthMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction,
) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return next();
  }
  const token = header.slice("Bearer ".length);
  try {
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: `${SUPABASE_URL}/auth/v1`,
    });
    req.supabaseUser = {
      sub: payload.sub!,
      user_role: (payload as Record<string, unknown>).user_role as string | undefined,
      // `email` is a standard Supabase/GoTrue JWT claim; surfaced here so
      // getAuth (below) can hand it to ensureOwnerOrg at wizard bootstrap
      // (TEN-012) — it derives the new org's name from the email's local-part.
      email: (payload as Record<string, unknown>).email as string | undefined,
      // Email-verification signal for requireVerifiedEmail (TEN-012 Task 6).
      // Determined EMPIRICALLY against this repo's disposable GoTrue: a
      // confirmed user's access token carries the boolean at
      // `payload.user_metadata.email_verified` (true); there is NO top-level
      // `payload.email_verified` and NO `email_confirmed_at` claim. We still
      // read a top-level `email_verified` as a fallback in case a future
      // GoTrue/JWT-template change surfaces it there. When neither is present
      // the value is left `undefined` (NOT coerced to false) so the gate can
      // distinguish "explicitly unverified" from "claim absent" — see
      // requireVerifiedEmail.ts.
      emailVerified: extractEmailVerified(payload as Record<string, unknown>),
    };
  } catch {
    // Invalid/expired token — leave req.supabaseUser unset, requireSignedIn
    // (app.ts) is what actually rejects the request; this middleware only
    // populates identity — "attach if present, let the route decide".
  }
  next();
}

export function getAuth(req: Request): {
  userId: string | null;
  userRole: string | null;
  email: string | null;
  // Tri-state: `true`/`false` reflect an explicit JWT claim; `undefined` means
  // the token carried no verification claim at all (see requireVerifiedEmail.ts
  // for why absence must NOT be treated the same as `false`).
  emailVerified: boolean | undefined;
} {
  return {
    userId: req.supabaseUser?.sub ?? null,
    userRole: req.supabaseUser?.user_role ?? null,
    email: req.supabaseUser?.email ?? null,
    emailVerified: req.supabaseUser?.emailVerified,
  };
}
