// Pure logic for the `events` Edge Function: validation, origin check, country, rate limiting.
// No network, no database, no storage of IPs. Tested under Node (.github/tests/analytics.test.mjs).
import { SCHEMA, BANNED_PROP_WORDS } from './schema.js';

export const LIMITS = { maxBody: 8192, maxEvents: 20, perMinute: 60 };
export const ALLOWED_ORIGINS = [/^https:\/\/([a-z0-9-]+\.)?bobolearns\.com$/, /^http:\/\/localhost(:\d+)?$/, /^http:\/\/127\.0\.0\.1(:\d+)?$/];
export const originAllowed = (origin) => !!origin && ALLOWED_ORIGINS.some((r) => r.test(origin));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TAG = /^[a-z0-9_-]{1,40}$/;
const DOMAIN = /^[a-z0-9.-]{1,80}$/;
const VERSION = /^[0-9A-Za-z._-]{1,20}$/;
const BANNED = new Set(BANNED_PROP_WORDS);

export const bannedKey = (key) => String(key).toLowerCase().split(/[_\-\s.]+/).some((w) => BANNED.has(w));

function propOk(spec, v) {
  if (!spec) return false;
  if (spec.enum) return spec.enum.includes(v);
  if (spec.re) return typeof v === 'string' && new RegExp(spec.re).test(v);
  return false;
}

// Returns true when every prop is allowed for this event and its value matches. Unknown or banned props fail the event.
export function propsOk(def, props) {
  if (props === undefined) props = {};
  if (!props || typeof props !== 'object' || Array.isArray(props)) return false;
  for (const [k, v] of Object.entries(props)) {
    if (bannedKey(k)) return false;
    if (!propOk(def.props[k], v)) return false;
  }
  for (const [k, v] of Object.entries(def.required || {})) if (props[k] !== v) return false;
  return true;
}

// The country comes from the edge header only. Anything else (XX, T1, junk) is null.
export function countryFrom(headers) {
  const c = String(headers.get('cf-ipcountry') || '').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(c) && c !== 'XX' && c !== 'T1' ? c : null;
}

// body: { app, anon_id, session_id, platform, app_version, source:{utm_source,utm_medium,utm_campaign,referrer_domain}, events:[{event, props}] }
// Returns { error } for a bad envelope, otherwise { rows, rejected }. The row shape is what public.analytics_ingest takes.
// A row never has a user_id, an IP or any free text.
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
  const tag = (v) => (typeof v === 'string' && TAG.test(v) ? v : null);
  const common = {
    app: body.app, anon_id: anon, session_id: session, platform: body.platform,
    app_version: typeof body.app_version === 'string' && VERSION.test(body.app_version) ? body.app_version : null,
    country,
    utm_source: tag(src.utm_source), utm_medium: tag(src.utm_medium), utm_campaign: tag(src.utm_campaign),
    referrer_domain: typeof src.referrer_domain === 'string' && DOMAIN.test(src.referrer_domain) ? src.referrer_domain : null,
  };
  const rows = [];
  let rejected = 0;
  for (const e of body.events) {
    const def = e && typeof e.event === 'string' ? SCHEMA.events[e.event] : null;
    if (!def || (def.apps && !def.apps.includes(body.app)) || !propsOk(def, e.props)) { rejected++; continue; }
    rows.push({ ...common, event: e.event, props: e.props || {} });
  }
  return { rows, rejected };
}

// Rate limiting keyed by an HMAC of the IP with a key that changes every UTC day. The key lives only in memory
// (set ANALYTICS_RL_SECRET to share it between instances; otherwise each instance makes its own random one).
// Yesterday's key is dropped, so yesterday's hashes can never be matched to an address. Nothing here is written anywhere.
export function createLimiter({ secret, now = () => Date.now(), perMinute = LIMITS.perMinute }) {
  let day = '';
  let key = null;
  let hits = new Map();
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
  return {
    async limited(ip) {
      const t = now();
      const k = await dayKey(t);
      const sig = new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(String(ip))));
      const id = Array.from(sig.slice(0, 12), (b) => b.toString(16).padStart(2, '0')).join('');
      const list = (hits.get(id) || []).filter((x) => t - x < 60_000);
      list.push(t);
      hits.set(id, list);
      if (hits.size > 5000) hits.clear();
      return list.length > perMinute;
    },
    size: () => hits.size,
    dayKeyId: () => day,
  };
}
