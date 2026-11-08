// Core of the confirm-age Edge Function, kept free of Deno and Supabase imports so it can be
// unit-tested with `node --test` (see handler.test.ts). index.ts wires in the real admin client.
//
// What it does: for the signed-in caller only, record that they confirmed the age statement
// ("I'm at least 13 years old, and at least 16 if I live in the EU or UK.") in the user's
// app_metadata. app_metadata can be changed only with the service role, never from the browser,
// so the flag cannot be forged by editing a profile.

export const AGE_RULE_VERSION = "age-v1";

export interface CallerUser {
  id: string;
  is_anonymous?: boolean;
  app_metadata?: Record<string, unknown> | null;
}

export interface Deps {
  /** Verifies the JWT with the auth server and returns the user, or null if it is not a real user. */
  getUser: (jwt: string) => Promise<CallerUser | null>;
  /** Service-role write of app_metadata for exactly one user id. */
  setAppMetadata: (userId: string, metadata: Record<string, unknown>) => Promise<{ error: string | null }>;
  now?: () => Date;
}

const ORIGIN_OK = /^https:\/\/([a-z0-9-]+\.)?bobolearns\.com$|^http:\/\/localhost:\d+$/;

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  const h: Record<string, string> = {
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
  if (ORIGIN_OK.test(origin)) h["Access-Control-Allow-Origin"] = origin;
  return h;
}

function json(req: Request, status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), "Content-Type": "application/json" },
  });
}

export async function handle(req: Request, deps: Deps): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(req) });
  if (req.method !== "POST") return json(req, 405, { error: "method_not_allowed" });

  const auth = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(\S+)$/i.exec(auth);
  if (!m) return json(req, 401, { error: "sign_in_required" });

  let user: CallerUser | null = null;
  try {
    user = await deps.getUser(m[1]);
  } catch {
    return json(req, 401, { error: "sign_in_required" });
  }
  // The publishable (anon) key is also a valid JWT but has no user; anonymous sessions are rejected too.
  if (!user || !user.id || user.is_anonymous) return json(req, 401, { error: "sign_in_required" });

  // The request body is ignored on purpose: the server alone decides the timestamp and rule version.
  const confirmedAt = (deps.now ? deps.now() : new Date()).toISOString();
  const metadata = {
    ...(user.app_metadata ?? {}),
    age_confirmed_at: confirmedAt,
    age_rule_version: AGE_RULE_VERSION,
  };
  const { error } = await deps.setAppMetadata(user.id, metadata);
  if (error) return json(req, 500, { error: "could_not_save" });
  return json(req, 200, { ok: true, age_confirmed_at: confirmedAt, age_rule_version: AGE_RULE_VERSION });
}
