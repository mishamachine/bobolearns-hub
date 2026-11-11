// Ingest for first-party guest events. Insert only: the browser posts a small batch; this checks it against the
// allow-list in schema.js and writes it through public.analytics_ingest() with the service role.
//
// Deploy WITHOUT JWT verification (the browser sends a plain text/plain POST, no auth header, so beacons work):
//   supabase functions deploy events --no-verify-jwt        <- an operator step; not done by the PR that added this file
// Secrets it uses: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (provided by Supabase to every function).
// Optional: ANALYTICS_RL_SECRET (shares the rate-limit key between instances), EVENTS_DISABLED=1 (stop writing, no redeploy).
//
// POST { app, anon_id, session_id, platform, app_version?, source?, events:[{ event, props }] } -> { ok, n, rejected }
// The IP is used for two things only and never stored: the country (edge header) and a daily-rotating HMAC for rate limits.
import { LIMITS, originAllowed, countryFrom, validateBatch, createLimiter } from './core.js';

const limiter = createLimiter({ secret: Deno.env.get('ANALYTICS_RL_SECRET') ?? '' });

const cors = (origin: string | null): Record<string, string> => ({
  'Access-Control-Allow-Origin': origin && originAllowed(origin) ? origin : 'https://bobolearns.com',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type',
  Vary: 'Origin',
});
const json = (body: unknown, status: number, h: Record<string, string>) =>
  new Response(JSON.stringify(body), { status, headers: { ...h, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  const origin = req.headers.get('origin');
  const h = cors(origin);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: h });
  if (req.method !== 'POST') return json({ error: 'method' }, 405, h);
  if (!originAllowed(origin)) return json({ error: 'origin' }, 403, h);
  if (Deno.env.get('EVENTS_DISABLED') === '1') return json({ ok: true, n: 0, disabled: true }, 200, h);

  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) return json({ error: 'not_configured' }, 503, h);

  const ip = req.headers.get('cf-connecting-ip') || req.headers.get('x-forwarded-for')?.split(',')[0].trim() || 'unknown';
  if (await limiter.limited(ip)) return json({ error: 'rate_limited' }, 429, h);

  const raw = await req.text();
  if (raw.length > LIMITS.maxBody) return json({ error: 'too_large' }, 413, h);
  let body: unknown;
  try { body = JSON.parse(raw); } catch { return json({ error: 'bad_json' }, 400, h); }

  const out = validateBatch(body, countryFrom(req.headers));
  if ('error' in out) return json({ error: out.error }, 400, h);
  if (!out.rows.length) return json({ ok: true, n: 0, rejected: out.rejected }, 200, h);

  const res = await fetch(`${url}/rest/v1/rpc/analytics_ingest`, {
    method: 'POST',
    headers: { apikey: key, ...(key.startsWith('sb_') ? {} : { Authorization: `Bearer ${key}` }), 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_rows: out.rows }),
  });
  if (!res.ok) return json({ error: 'db', status: res.status }, 502, h);
  return json({ ok: true, n: out.rows.length, rejected: out.rejected }, 200, h);
});
