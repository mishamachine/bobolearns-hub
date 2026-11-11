// Ingest for first-party guest events. Insert only: the browser posts a small batch; handler.js checks it against the
// allow-list in schema.js and core.js writes it through public.analytics_ingest() with the service role.
//
// Deploy WITHOUT JWT verification (the browser sends a plain text/plain POST, no auth header, so beacons work):
//   supabase functions deploy events --no-verify-jwt        <- an operator step; not done by the PR that added this file
// Secrets it uses: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (provided by Supabase to every function).
// Optional: ANALYTICS_RL_SECRET (shares the rate-limit key between instances), EVENTS_DISABLED=1 (stop writing, no redeploy),
// EVENTS_DEV_ORIGINS=1 (also accept http://localhost origins; development only, never in production).
//
// POST { app, anon_id, session_id, platform, app_version?, source?, events:[{ event, props }] } -> { ok, n, rejected }
// The IP is used for two things only and never stored: the country (edge header) and a daily-rotating HMAC for rate limits.
import { createLimiter } from './core.js';
import { createEventsHandler } from './handler.js';

const limiter = createLimiter({ secret: Deno.env.get('ANALYTICS_RL_SECRET') ?? '' });
Deno.serve(createEventsHandler({ limiter, env: (k: string) => Deno.env.get(k) }));
