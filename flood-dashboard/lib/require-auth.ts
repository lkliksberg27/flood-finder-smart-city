import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";

/**
 * Guard for API routes that mutate data or spend money.
 *
 * The dashboard itself is deliberately public and read-only (see AuthGate),
 * so GET endpoints stay open. Anything that writes, deletes, creates an
 * account, or calls a paid API must go through here first.
 *
 * Usage:
 *   const denied = await requireAuth(request);
 *   if (denied) return denied;
 *
 * Returns a 401 NextResponse when the caller is not authenticated, or null
 * when the caller presented a valid Supabase session token.
 */
export async function requireAuth(request: Request): Promise<NextResponse | null> {
  const authHeader = request.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return NextResponse.json(
      { error: "Authentication required" },
      { status: 401 }
    );
  }

  const supabase = createServiceClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser(authHeader.slice(7));

  if (error || !user) {
    return NextResponse.json(
      { error: "Invalid or expired session, please sign in again" },
      { status: 401 }
    );
  }

  return null;
}

/**
 * Blocks a route outright unless an explicit shared secret is presented.
 * Used for one-off administrative endpoints that should never be reachable
 * from the open internet, even by a signed-in dashboard user.
 *
 * If the secret env var is not configured the route is refused rather than
 * left open, so a missing variable fails closed instead of wide open.
 */
export function requireSecret(request: Request, envVar: string): NextResponse | null {
  const expected = process.env[envVar];
  if (!expected) {
    return NextResponse.json(
      {
        error: `This endpoint is disabled because ${envVar} is not configured on the server.`,
      },
      { status: 403 }
    );
  }

  const provided =
    request.headers.get("x-admin-secret") ??
    request.headers.get("authorization")?.replace(/^Bearer /, "");

  if (provided !== expected) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  return null;
}
