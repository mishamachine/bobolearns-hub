// Pure logic for the `events` Edge Function: validation, origin check, country, rate limiting.
// No network, no database, no storage of IPs. Tested under Node (.github/tests/analytics.test.mjs).
import { SCHEMA, BANNED_PROP_WORDS } from './schema.js';

export const LIMITS = { maxBody: 8192, maxEvents: 20, perMinute: 60, maxTracked: 5000 };
// Production origins only. Localhost is a development switch: pass allowDev (the function sets it from EVENTS_DEV_ORIGINS=1).
const PROD_ORIGIN = /^https:\/\/([a-z0-9-]+\.)?bobolearns\.com$/;
const DEV_ORIGINS = [/^http:\/\/localhost(:\d+)?$/, /^http:\/\/127\.0\.0\.1(:\d+)?$/];
export const originAllowed = (origin, allowDev = false) => !!origin && (PROD_ORIGIN.test(origin) || (allowDev && DEV_ORIGINS.some((r) => r.test(origin))));

// Events at or next to account creation or linking. Their rows store ONLY the event name, the app, the day, the page area
// (props.surface) and fresh random IDs: no device ID, session ID, platform, app version, source, referrer, country, method
// or auth_state. So they cannot be matched to the same device's other rows. They are counted as events, never per ID.
export const ONE_OFF_ID_EVENTS = ['signup_start', 'sign_up', 'sign_in', 'guest_progress_moved'];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TAG = /^[a-z0-9_-]{1,40}$/;
const DOMAIN = /^[a-z0-9.-]{1,80}$/;
const VERSION = /^[0-9A-Za-z._-]{1,20}$/;
const BANNED = new Set(BANNED_PROP_WORDS);
// Schema maps are looked up with hasOwn so names like "constructor", "__proto__" or "toString" never reach Object.prototype.
const own = (obj, key) => typeof key === 'string' && Object.hasOwn(obj, key) ? obj[key] : undefined;

export const bannedKey = (key) => String(key).toLowerCase().split(/[_\-\s.]+/).some((w) => BANNED.has(w));

function propOk(spec, v) {
  if (!spec) return false;
  if (spec.enum) return spec.enum.includes(v);
  if (spec.re) return typeof v === 'string' && new RegExp(spec.re).test(v);
  return false;
}

// True when every prop is allowed for this event and its value matches. Unknown or banned props fail the event.
export function propsOk(def, props) {
  if (props === undefined) props = {};
  if (!props || typeof props !== 'object' || Array.isArray(props)) return false;
  for (const [k, v] of Object.entries(props)) {
    if (bannedKey(k)) return false;
    if (!propOk(own(def.props, k), v)) return false;
  }
  for (const [k, v] of Object.entries(def.required || {})) if (props[k] !== v) return false;
  return true;
}

// The country comes from the edge header only (UNVERIFIED: Supabase Edge Functions run behind Cloudflare, which sets
// cf-ipcountry; confirm after the first deploy). Anything else (XX, T1, junk, missing) is null.
export function countryFrom(headers) {
  const c = String(headers.get('cf-ipcountry') || '').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(c) && c !== 'XX' && c !== 'T1' ? c : null;
}

// The one header the rate limiter may use. Chosen: cf-connecting-ip, which the platform's edge sets itself and
// overwrites if a client sends it (UNVERIFIED on Supabase Edge: confirm after the first deploy). The leftmost
// x-forwarded-for is client-controlled, so it is never read. A request without the header is "no-ip": it gets no per-IP
// bucket (one shared bucket would let one client lock everyone out); the limiter counts those in one global counter instead.
export const clientIp = (headers) => String(headers.get('cf-connecting-ip') || '').trim().slice(0, 64) || 'no-ip';

const tagOrNull = (v) => (typeof v === 'string' && !v.includes('@') && TAG.test(v) ? v : null);

// body: { app, anon_id, session_id, platform, app_version, source:{utm_source,utm_medium,utm_campaign,referrer_domain}, events:[{event, props}] }
// Returns { error } for a bad envelope or when no event passes; otherwise { rows, rejected }.
// A row never has a user_id, an IP, a time of day or free text. Its shape is what public.analytics_ingest takes.
// Rows for ONE_OFF_ID_EVENTS are reduced to the minimum (see above).
export function validateBatch(body, country) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'bad_request' };
  if (!SCHEMA.apps.includes(body.app)) return { error: 'bad_app' };
  const anon = String(body.anon_id || '').toLowerCase();
  const session = String(body.session_id || '').toLowerCase();
  if (!UUID.test(anon) || !UUID.test(session)) return { error: 'bad_id' };
  if (!SCHEMA.platforms.includes(body.platform)) return { error: 'bad_platform' };
  if (!Array.isArray(body.events) || !body.events.length) return { error: 'bad_request' };
  if (body.events.length > LIMITS.maxEvents) return { error: 'too_many_events' };
  const src = body.source && typeof body.source === 'object' && !Array.isArray(body.source) ? body.source : {};
  const common = {
    app: body.app, platform: body.platform,
    app_version: typeof body.app_version === 'string' && VERSION.test(body.app_version) ? body.app_version : null,
    country,
    utm_source: tagOrNull(src.utm_source), utm_medium: tagOrNull(src.utm_medium), utm_campaign: tagOrNull(src.utm_campaign),
    referrer_domain: typeof src.referrer_domain === 'string' && !src.referrer_domain.includes('@') && DOMAIN.test(src.referrer_domain) ? src.referrer_domain : null,
  };
  const rows = [];
  let rejected = 0;
  for (const e of body.events) {
    const def = e && typeof e === 'object' ? own(SCHEMA.events, e.event) : undefined;
    if (!def || (def.apps && !def.apps.includes(body.app)) || !propsOk(def, e.props)) { rejected++; continue; }
    if (ONE_OFF_ID_EVENTS.includes(e.event)) {
      const props = e.props && typeof e.props.surface === 'string' ? { surface: e.props.surface } : {};
      rows.push({
        app: body.app, event: e.event, props, anon_id: crypto.randomUUID(), session_id: crypto.randomUUID(),
        platform: null, app_version: null, country: null, utm_source: null, utm_medium: null, utm_campaign: null, referrer_domain: null,
      });
      continue;
    }
    rows.push({ ...common, event: e.event, props: e.props || {}, anon_id: anon, session_id: session });
  }
  if (!rows.length) return { error: 'no_valid_events', rejected };
  return { rows, rejected };
}

// Rate limiting keyed by an HMAC of the IP with a key that changes every UTC day: the day key is HMAC(secret, date),
// or random bytes when no secret is set (set ANALYTICS_RL_SECRET to share it between instances; otherwise each instance
// makes its own). Keys and tables live only in memory. At the day change the table is dropped and the old key is
// replaced, so yesterday's hashes are gone and a new table can't be matched to them. Nothing is written anywhere.
// Requests with no usable IP ("no-ip") skip the per-IP table and share one global counter (noIpPerMinute, default 600).
// When the table is full, expired entries go first, then the least recently seen one. An overflow therefore drops only the
// oldest entries (a client dropped while still active starts a fresh count: best effort, bounded by the table size).
export function createLimiter({ secret, now = () => Date.now(), perMinute = LIMITS.perMinute, maxTracked = LIMITS.maxTracked, noIpPerMinute = 600 }) {
  let noIpHits = [];
  let day = '';
  let key = null;
  let hits = new Map(); // id -> timestamps; re-inserted on every hit, so Map order is least-recent first
  const rand = () => crypto.getRandomValues(new Uint8Array(32));
  async function dayKey(t) {
    const d = new Date(t).toISOString().slice(0, 10);
    if (d !== day) {
      day = d; hits = new Map();
      let base = rand();
      if (secret) {
        const sk = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
        base = new Uint8Array(await crypto.subtle.sign('HMAC', sk, new TextEncoder().encode(d)));
      }
      key = await crypto.subtle.importKey('raw', base, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    }
    return key;
  }
  function makeRoom(t) {
    if (hits.size < maxTracked) return;
    for (const [id, list] of hits) if (t - list[list.length - 1] >= 60_000) hits.delete(id);
    while (hits.size >= maxTracked) hits.delete(hits.keys().next().value);
  }
  return {
    async limited(ip) {
      const t = now();
      if (ip === 'no-ip') {
        noIpHits = noIpHits.filter((x) => t - x < 60_000);
        noIpHits.push(t);
        return noIpHits.length > noIpPerMinute;
      }
      const k = await dayKey(t);
      const sig = new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(String(ip))));
      const id = Array.from(sig.slice(0, 12), (b) => b.toString(16).padStart(2, '0')).join('');
      const list = (hits.get(id) || []).filter((x) => t - x < 60_000);
      list.push(t);
      hits.delete(id);
      makeRoom(t);
      hits.set(id, list);
      return list.length > perMinute;
    },
    size: () => hits.size,
    dayKeyId: () => day,
  };
}
