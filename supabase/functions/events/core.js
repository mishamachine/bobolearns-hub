// Pure logic for the `events` Edge Function: validation, origin check, country, rate limiting.
// No network, no database, no storage of IPs. Tested under Node (.github/tests/analytics.test.mjs).
import { SCHEMA, BANNED_PROP_WORDS } from './schema.js';

export const LIMITS = { maxBody: 8192, maxEvents: 20, perMinute: 60, maxTracked: 5000 };
// Production origins only. Localhost is a development switch: pass allowDev (the function sets it from EVENTS_DEV_ORIGINS=1).
const PROD_ORIGIN = /^https:\/\/([a-z0-9-]+\.)?bobolearns\.com$/;
const DEV_ORIGINS = [/^http:\/\/localhost(:\d+)?$/, /^http:\/\/127\.0\.0\.1(:\d+)?$/];
export const originAllowed = (origin, allowDev = false) => !!origin && (PROD_ORIGIN.test(origin) || (allowDev && DEV_ORIGINS.some((r) => r.test(origin))));

// Sign-up and sign-in rows never keep the device ID or the session ID: the server gives each a fresh random one,
// so a sign-up cannot be matched to the visits before it. Sign-ups are counted as events.
export const ONE_OFF_ID_EVENTS = ['sign_up', 'sign_in'];

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
// x-forwarded-for is client-controlled, so it is never read. A request without the header shares one "no-ip" bucket.
export const clientIp = (headers) => String(headers.get('cf-connecting-ip') || '').trim().slice(0, 64) || 'no-ip';

const tagOrNull = (v) => (typeof v === 'string' && !v.includes('@') && TAG.test(v) ? v : null);

// body: { app, anon_id, session_id, platform, app_version, source:{utm_source,utm_medium,utm_campaign,referrer_domain}, events:[{event, props}] }
// Returns { error } for a bad envelope or when no event passes; otherwise { rows, rejected }.
// A row never has a user_id, an IP, a time of day or free text. Its shape is what public.analytics_ingest takes.
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
    const oneOff = ONE_OFF_ID_EVENTS.includes(e.event);
    rows.push({
      ...common, event: e.event, props: e.props || {},
      anon_id: oneOff ? crypto.randomUUID() : anon,
      session_id: oneOff ? crypto.randomUUID() : session,
    });
  }
  if (!rows.length) return { error: 'no_valid_events', rejected };
  return { rows, rejected };
}

// Rate limiting keyed by an HMAC of the IP with a key that changes every UTC day. The key lives only in memory
// (set ANALYTICS_RL_SECRET to share it between instances; otherwise each instance makes its own random one).
// Yesterday's key and table are dropped, so yesterday's hashes can never be matched to an address. Nothing is written anywhere.
// When the table is full, expired entries go first, then the least recently seen one: the cap never resets anyone's count.
export function createLimiter({ secret, now = () => Date.now(), perMinute = LIMITS.perMinute, maxTracked = LIMITS.maxTracked }) {
  let day = '';
  let key = null;
  let hits = new Map(); // id -> timestamps; re-inserted on every hit, so Map order is least-recent first
  const rand = () => crypto.getRandomValues(new Uint8Array(32));
  async function dayKey(t) {
    const d = new Date(t).toISOString().slice(0, 10);
    if (d !== day) {
      day = d; hits = new Map();
      const base = secret ? new TextEncoder().encode(secret + '|' + d) : rand();
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
