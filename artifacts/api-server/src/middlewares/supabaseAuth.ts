import type { Request, Response, NextFunction } from "express";
import { createClient } from "@supabase/supabase-js";
import { jwtVerify, createRemoteJWKSet } from "jose";

const SUPABASE_URL = process.env.SUPABASE_URL!;
const JWKS = createRemoteJWKSet(
  new URL(`${SUPABASE_URL}/auth/v1/.well-known/jwks.json`),
);

export const supabaseAdmin = createClient(
  SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      supabaseUser?: { sub: string; user_role?: string };
    }
  }
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
    };
  } catch {
    // Invalid/expired token — leave req.supabaseUser unset, requireSignedIn
    // (app.ts) is what actually rejects the request; this middleware only
    // populates identity, mirroring clerkMiddleware()'s own non-throwing
    // "attach if present, let the route decide" behavior.
  }
  next();
}

export function getAuth(req: Request): { userId: string | null; userRole: string | null } {
  return {
    userId: req.supabaseUser?.sub ?? null,
    userRole: req.supabaseUser?.user_role ?? null,
  };
}
