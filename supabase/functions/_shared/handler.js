// The two Edge Function handlers as plain Request -> Response functions, so Node tests can drive them.
// index.ts and ../analytics-dashboard/index.ts only wire them to Deno.serve and the environment.
import { LIMITS, originAllowed, countryFrom, clientIp, validateBatch } from './core.js';

const cors = (origin, allowDev) => ({
  'Access-Control-Allow-Origin': origin && originAllowed(origin, allowDev) ? origin : 'https://bobolearns.com',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type',
  Vary: 'Origin',
});
const json = (body, status, h = {}) => new Response(JSON.stringify(body), { status, headers: { ...h, 'Content-Type': 'application/json' } });

// Reads at most `max` bytes. Returns the text, or null when the body is bigger (the stream is cancelled, not drained).
export async function readCapped(req, max) {
  if (!req.body) return '';
  const reader = req.body.getReader();
  const chunks = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > max) { await reader.cancel().catch(() => {}); return null; }
    chunks.push(value);
  }
  const all = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) { all.set(c, o); o += c.length; }
  return new TextDecoder().decode(all);
}

// deps: { limiter, env: (name) => string|undefined, fetch }
export function createEventsHandler({ limiter, env, fetch: doFetch = fetch }) {
  return async function handle(req) {
    const origin = req.headers.get('origin');
    const allowDev = env('EVENTS_DEV_ORIGINS') === '1';
    const h = cors(origin, allowDev);
    if (req.method === 'OPTIONS') return new Response('ok', { headers: h });
    if (req.method !== 'POST') return json({ error: 'method' }, 405, h);
    if (!originAllowed(origin, allowDev)) return json({ error: 'origin' }, 403, h);
    if (env('EVENTS_DISABLED') === '1') return json({ ok: true, n: 0, disabled: true }, 200, h);

    const url = env('SUPABASE_URL');
    const key = env('SUPABASE_SERVICE_ROLE_KEY');
    if (!url || !key) return json({ error: 'not_configured' }, 503, h);

    if (await limiter.limited(clientIp(req.headers))) return json({ error: 'rate_limited' }, 429, h);

    // Size first: a declared length over the cap is refused before any byte is read; the read itself is capped too.
    const declared = Number(req.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > LIMITS.maxBody) return json({ error: 'too_large' }, 413, h);
    const raw = await readCapped(req, LIMITS.maxBody);
    if (raw === null) return json({ error: 'too_large' }, 413, h);
    let body;
    try { body = JSON.parse(raw); } catch { return json({ error: 'bad_json' }, 400, h); }

    const out = validateBatch(body, countryFrom(req.headers));
    if (out.error) return json({ error: out.error }, 400, h);

    let res;
    try {
      res = await doFetch(`${url}/rest/v1/rpc/analytics_ingest`, {
        method: 'POST',
        headers: { apikey: key, ...(key.startsWith('sb_') ? {} : { Authorization: `Bearer ${key}` }), 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_rows: out.rows }),
      });
    } catch { return json({ error: 'db' }, 502, h); }
    if (!res.ok) return json({ error: 'db', status: res.status }, 502, h);
    return json({ ok: true, n: out.rows.length, rejected: out.rejected }, 200, h);
  };
}

// Compares two strings without leaking where they differ: both are hashed to 32 bytes first, then every byte is compared.
export async function secretsEqual(a, b) {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(String(a))), crypto.subtle.digest('SHA-256', enc.encode(String(b)))]);
  const u = new Uint8Array(x), v = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < u.length; i++) diff |= u[i] ^ v[i];
  return diff === 0;
}

// Server-to-server read for the Board Room proxy. Holds the only path from the proxy to the aggregates: the proxy has just
// this function's URL and a shared secret, never a database key. No CORS headers (browsers are not meant to call it).
export function createDashboardHandler({ env, fetch: doFetch = fetch }) {
  return async function handle(req) {
    if (req.method !== 'GET') return json({ error: 'method' }, 405);
    const secret = env('ANALYTICS_DASHBOARD_SECRET');
    if (!secret || secret.length < 24) return json({ error: 'not_configured' }, 503);
    const given = req.headers.get('x-dashboard-secret') || '';
    if (!(await secretsEqual(given, secret))) return json({ error: 'unauthorized' }, 401);
    const url = env('SUPABASE_URL');
    const key = env('SUPABASE_SERVICE_ROLE_KEY');
    if (!url || !key) return json({ error: 'not_configured' }, 503);
    let res;
    try {
      res = await doFetch(`${url}/rest/v1/rpc/analytics_dashboard`, {
        method: 'POST',
        headers: { apikey: key, ...(key.startsWith('sb_') ? {} : { Authorization: `Bearer ${key}` }), 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_days: 35 }),
      });
    } catch { return json({ error: 'db' }, 502); }
    if (!res.ok) return json({ error: 'db', status: res.status }, 502);
    return new Response(await res.text(), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  };
}
