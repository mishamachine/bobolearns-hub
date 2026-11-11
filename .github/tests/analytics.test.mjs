// Tests for first-party guest analytics (events function, browser module, migration, privacy page).
// Run: node --test .github/tests/analytics.test.mjs   (also run by .github/scripts/check_site.py in CI)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const { SCHEMA, BANNED_PROP_WORDS } = await import(path.join(ROOT, 'supabase/functions/events/schema.js'));
const core = await import(path.join(ROOT, 'supabase/functions/events/core.js'));
const { validateBatch, propsOk, countryFrom, originAllowed, createLimiter, bannedKey, LIMITS } = core;

const A = '3b1f9c2e-7a54-4d0b-9e21-5c8d6f0a1b23';
const S = '9d2c4e61-0f3a-4b7d-8a15-2e6b7c9d0e41';
const env = (over = {}) => ({ app: 'hub', anon_id: A, session_id: S, platform: 'web', events: [{ event: 'app_open', props: { surface: 'home', auth_state: 'guest' } }], ...over });

// ---------- the browser module, run in a sandbox ----------
function loadClient({ enabled = true, dnt = false, cookie = '', search = '', referrer = '', path: pathname = '/', storage = {}, app = 'hub', nodes = null } = {}) {
  const sent = [];
  const mem = (init) => { const m = new Map(Object.entries(init)); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), _m: m }; };
  const local = mem(storage), sess = mem({});
  const listeners = [];
  const win = {
    BOBO_CONFIG: { rootHost: 'bobolearns.com', analytics: { enabled, app, endpoint: 'https://example.test/functions/v1/events' } },
    crypto: globalThis.crypto, localStorage: local, sessionStorage: sess,
    navigator: { doNotTrack: dnt ? '1' : null, sendBeacon: (url, blob) => { sent.push({ url, blob }); return true; } },
  };
  const doc = { cookie, referrer, addEventListener: (t, f) => listeners.push([t, f]), querySelectorAll: (sel) => (nodes && nodes[sel]) || [], getElementById: () => null };
  const ctx = { window: win, document: doc, location: { pathname, search }, navigator: win.navigator, URL, URLSearchParams, Blob, fetch: () => Promise.resolve(), console };
  vm.runInNewContext(read('assets/js/bb-analytics.js'), ctx);
  const payloads = async () => Promise.all(sent.map(async (s) => JSON.parse(await s.blob.text())));
  return { api: win.bbAnalytics, local, sess, sent, payloads, listeners, doc };
}

test('client schema equals the server allow-list', () => {
  const { api } = loadClient();
  assert.deepEqual(JSON.parse(JSON.stringify(api.SCHEMA)), JSON.parse(JSON.stringify(SCHEMA)));
});

test('flag off (the shipped default): nothing is sent and no ID is created', async () => {
  assert.equal(JSON.parse(JSON.stringify(vm.runInNewContext('(' + read('assets/js/config.js').replace('window.BOBO_CONFIG =', '') .replace(/;\s*$/, '') + ')', { window: {} }))).analytics.enabled, false);
  const c = loadClient({ enabled: false });
  assert.equal(c.api.track('app_open', { surface: 'home', auth_state: 'guest' }), false);
  assert.equal(c.sent.length, 0);
  assert.equal(c.local._m.size, 0, 'no ID written');
});

test('flag on: app_open fires once with a random v4 UUID, stable per device', async () => {
  const c = loadClient({});
  const [p] = await c.payloads();
  assert.equal(c.sent.length, 1);
  assert.match(p.anon_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(c.api.anonId(false), p.anon_id);
  const again = loadClient({ storage: { 'bb.anon.v1': p.anon_id } });
  assert.equal((await again.payloads())[0].anon_id, p.anon_id, 'same device, same ID');
  assert.equal(p.platform, 'web');
  assert.deepEqual(p.events, [{ event: 'app_open', props: { surface: 'home', auth_state: 'guest' } }]);
});

test('the payload never carries a user ID, email or any account link; guest vs member is a flag only', async () => {
  const guest = (await loadClient({}).payloads())[0];
  const member = (await loadClient({ cookie: 'sb-ywcrzkvwamjchjjkfrve-auth-token.0=SECRETVALUE' }).payloads())[0];
  assert.equal(guest.events[0].props.auth_state, 'guest');
  assert.equal(member.events[0].props.auth_state, 'member');
  const text = JSON.stringify([guest, member]);
  for (const bad of ['user_id', 'userId', 'email', 'SECRETVALUE', 'account_linked', 'identify']) assert.ok(!text.includes(bad), bad);
  assert.deepEqual(Object.keys(member).sort(), ['anon_id', 'app', 'events', 'platform', 'session_id', 'source']);
});

test('Do Not Track and the off switch stop everything; reset makes a new ID', async () => {
  assert.equal(loadClient({ dnt: true }).sent.length, 0);
  assert.equal(loadClient({ storage: { 'bb.analytics.off': '1' } }).sent.length, 0);
  const c = loadClient({});
  const id = c.api.anonId(false);
  c.api.reset();
  assert.equal(c.api.anonId(false), null);
  assert.notEqual(c.api.anonId(true), id);
  c.api.setOff(true);
  assert.equal(c.api.track('sign_in', { method: 'email' }), false);
});

test('guest name: deterministic, same shape, known vector', () => {
  const { api } = loadClient({ enabled: false });
  assert.match(api.guestName(A), /^Guest [A-Z][a-z]+-[A-Z][a-z]+-\d{4}$/);
  assert.equal(api.guestName(A), api.guestName(A));
  assert.notEqual(api.guestName(A), api.guestName(S));
  // Fixed vectors: every copy of this module (other apps) must give the same names.
  assert.equal(api.guestName('00000000-0000-4000-8000-000000000000'), 'Guest Jolly-Quokka-2595');
  assert.equal(api.guestName(A), 'Guest Jolly-Quokka-5243');
});

test('client cleanProps: allow-list only, no free text, sign_up must be guest', () => {
  const { api } = loadClient({ enabled: false });
  assert.equal(api.cleanProps('app_open', { surface: 'home', email: 'a@b.c' }), null);
  assert.equal(api.cleanProps('app_open', { surface: 'Hello there, free text!' }), null);
  assert.equal(api.cleanProps('sign_up', { auth_state: 'member', method: 'email' }), null);
  assert.deepEqual(JSON.parse(JSON.stringify(api.cleanProps('sign_up', { auth_state: 'guest', method: 'google' }))), { auth_state: 'guest', method: 'google' });
  assert.equal(api.cleanProps('not_an_event', {}), null);
});

test('source: lowercase utm codes and the referrer domain only; own domain is not a referrer', async () => {
  const c = loadClient({ search: '?utm_source=Facebook&utm_medium=social&utm_campaign=Bad%20Value&email=a@b.c', referrer: 'https://news.example.org/a/b?q=secret' });
  const [p] = await c.payloads();
  assert.deepEqual(p.source, { utm_source: 'facebook', utm_medium: 'social', referrer_domain: 'news.example.org' });
  const own = loadClient({ referrer: 'https://chess.bobolearns.com/x' });
  assert.deepEqual((await own.payloads())[0].source, {});
});

test('hub value event comes from a data attribute, not typed text', async () => {
  const c = loadClient({});
  const click = c.listeners.find(([t]) => t === 'click')[1];
  click({ target: { closest: () => ({ getAttribute: () => 'chess' }) } });
  const ps = await c.payloads();
  assert.deepEqual(ps[1].events[0], { event: 'site_open', props: { slug: 'chess' } });
  const other = loadClient({ app: 'chess' });
  assert.equal(other.api.track('site_open', { slug: 'x' }), false, 'hub-only event');
});

// ---------- the ingest function core ----------
test('a good batch becomes rows with no user_id and no IP; country comes from the edge header', () => {
  const out = validateBatch(env(), 'CA');
  assert.equal(out.rows.length, 1);
  assert.equal(out.rejected, 0);
  assert.deepEqual(Object.keys(out.rows[0]).sort(), ['anon_id', 'app', 'app_version', 'country', 'event', 'platform', 'props', 'referrer_domain', 'session_id', 'utm_campaign', 'utm_medium', 'utm_source']);
  assert.equal(out.rows[0].country, 'CA');
  const h = (v) => ({ get: (k) => (k === 'cf-ipcountry' ? v : null) });
  assert.equal(countryFrom(h('us')), 'US');
  for (const bad of ['XX', 'T1', '', 'USA', '1', null]) assert.equal(countryFrom(h(bad)), null, String(bad));
});

test('envelope fields that would link or identify are ignored, never stored', () => {
  const out = validateBatch(env({ user_id: 'u-123', email: 'a@b.c', ip: '1.2.3.4', events: [{ event: 'sign_up', props: { auth_state: 'guest', method: 'email' }, user_id: 'u-123' }] }), null);
  assert.equal(out.rows.length, 1);
  assert.ok(!JSON.stringify(out.rows).match(/u-123|a@b\.c|1\.2\.3\.4/));
});

test('banned prop words are rejected on every event and none exist in the schema', () => {
  for (const [name, def] of Object.entries(SCHEMA.events)) {
    for (const k of Object.keys(def.props)) assert.ok(!bannedKey(k), `${name}.${k}`);
    for (const word of BANNED_PROP_WORDS) {
      assert.equal(propsOk(def, { ...(def.required || {}), [word]: 'x' }), false, `${name} accepted banned prop ${word}`);
      assert.equal(propsOk(def, { ...(def.required || {}), [`my_${word}_thing`]: 'x' }), false, `${name} accepted banned prop my_${word}_thing`);
    }
  }
  for (const k of ['email', 'name', 'free_text', 'lat', 'lng', 'location', 'verse_ref', 'reading_path', 'document_title', 'booking_id', 'camera_frame', 'speech_text', 'ai_message', 'user_id', 'ip']) {
    assert.equal(bannedKey(k), true, k);
  }
  assert.equal(bannedKey('platform'), false, 'tokens, not substrings: platform is fine');
});

test('every string prop is an enum or a short code pattern (free text cannot fit)', () => {
  for (const [name, def] of Object.entries(SCHEMA.events)) for (const [k, spec] of Object.entries(def.props)) {
    assert.ok(spec.enum || spec.re, `${name}.${k}`);
    if (spec.re) { assert.ok(!spec.re.includes(' ') && !spec.re.includes('\\s') && !spec.re.includes('.*'), `${name}.${k}: pattern allows spaces or anything`); assert.ok(/\{\d*,?\d+\}/.test(spec.re), `${name}.${k}: pattern has no length bound`); }
  }
});

test('validation: wrong app, apps without a device ID, bad IDs, bounds, unknown events, sign_up rules', () => {
  assert.equal(validateBatch(env({ app: 'omg' }), null).error, 'bad_app');
  assert.equal(validateBatch(env({ app: 'stt' }), null).error, 'bad_app');
  assert.equal(validateBatch(env({ anon_id: 'not-a-uuid' }), null).error, 'bad_id');
  assert.equal(validateBatch(env({ anon_id: '3b1f9c2e-7a54-1d0b-9e21-5c8d6f0a1b23' }), null).error, 'bad_id', 'v4 only');
  assert.equal(validateBatch(env({ platform: 'tv' }), null).error, 'bad_platform');
  assert.equal(validateBatch(env({ events: [] }), null).error, 'bad_request');
  assert.equal(validateBatch(env({ events: Array(LIMITS.maxEvents + 1).fill({ event: 'guest_progress_moved' }) }), null).error, 'too_many_events');
  assert.equal(validateBatch(null, null).error, 'bad_request');
  const r = validateBatch(env({ events: [
    { event: 'app_open', props: { surface: 'home' } },
    { event: 'drop_table', props: {} },
    { event: 'app_open', props: { surface: 'home', email: 'a@b.c' } },
    { event: 'sign_up', props: { auth_state: 'member' } },
    { event: 'sign_up', props: { method: 'email' } },
    { event: 'site_open', props: { slug: 'chess' } },
    { event: 'app_open', props: { surface: { nested: 1 } } },
  ] }), null);
  assert.equal(r.rows.length, 2);
  assert.equal(r.rejected, 5);
  assert.equal(validateBatch(env({ app: 'chess', events: [{ event: 'site_open', props: { slug: 'x' } }] }), null).rows.length, 0, 'hub-only event');
});

test('source fields: only codes pass; junk becomes null', () => {
  const out = validateBatch(env({ source: { utm_source: 'Face book', utm_medium: 'social', utm_campaign: 'a@b.c', referrer_domain: 'https://x.com/a' }, app_version: '1.2.3' }), null);
  assert.deepEqual([out.rows[0].utm_source, out.rows[0].utm_medium, out.rows[0].utm_campaign, out.rows[0].referrer_domain, out.rows[0].app_version], [null, 'social', null, null, '1.2.3']);
});

test('origins: bobolearns.com and localhost only', () => {
  for (const o of ['https://bobolearns.com', 'https://woof.bobolearns.com', 'http://localhost:8000']) assert.ok(originAllowed(o), o);
  for (const o of ['https://evil.com', 'https://bobolearns.com.evil.com', 'http://bobolearns.com', null, '']) assert.ok(!originAllowed(o), String(o));
});

test('rate limit: a daily-rotating key; limit per minute; the new day starts clean', async () => {
  let t = Date.parse('2026-11-11T23:59:00Z');
  const lim = createLimiter({ secret: 'test-secret', now: () => t, perMinute: 3 });
  const res = [];
  for (let i = 0; i < 5; i++) res.push(await lim.limited('203.0.113.7'));
  assert.deepEqual(res, [false, false, false, true, true]);
  assert.equal(await lim.limited('203.0.113.8'), false, 'another address has its own bucket');
  assert.equal(lim.dayKeyId(), '2026-11-11');
  t = Date.parse('2026-11-12T00:00:30Z');
  assert.equal(await lim.limited('203.0.113.7'), false, 'old key dropped: yesterday\'s counts are gone');
  assert.equal(lim.dayKeyId(), '2026-11-12');
  assert.equal(lim.size(), 1, 'only today\'s hash is held');
  t += 61_000;
  assert.equal(await lim.limited('203.0.113.7'), false, 'window slides');
});

test('function source: service-role RPC only, no IP in the stored body, no GA/Meta, no table writes', () => {
  const src = read('supabase/functions/events/index.ts');
  assert.ok(src.includes('/rest/v1/rpc/analytics_ingest'));
  assert.ok(src.includes('p_rows: out.rows'));
  assert.ok(!/rest\/v1\/(?!rpc)/.test(src), 'no direct table REST writes');
  assert.ok(!/body: JSON\.stringify\([^)]*\bip\b/.test(src));
  assert.ok(src.includes('countryFrom(req.headers)'));
  assert.ok(!/console\.(log|info|warn|error)\([^)]*\bip\b/.test(src), 'IP is never logged');
});

// ---------- the migration ----------
const SQL = read('supabase/migrations/20261111000000_analytics_events.sql');
const tableBodies = [...SQL.matchAll(/create table if not exists analytics\.(\w+) \(([\s\S]*?)\n\);/g)];

test('migration: no user_id, email, name or IP column in any analytics table', () => {
  assert.ok(tableBodies.length >= 4);
  for (const [, name, body] of tableBodies) for (const col of ['user_id', 'email', 'name', 'ip', 'ip_address', 'lat', 'lng', 'account_id']) {
    assert.ok(!new RegExp(`^\\s+${col}\\s`, 'm').test(body), `${name} has column ${col}`);
  }
  assert.ok(!/references\s+auth\.users/i.test(SQL), 'no link to accounts');
});

test('migration: RLS on, no grants to anon or authenticated, ingest only for the service role', () => {
  for (const t of ['events', 'daily_app_stats', 'daily_source_stats', 'aggregate_runs']) assert.ok(SQL.includes(`alter table analytics.${t} enable row level security`), t);
  assert.ok(SQL.includes('revoke all on all tables in schema analytics from public, anon, authenticated'));
  assert.ok(!/create\s+policy/i.test(SQL), 'no policies');
  assert.ok(!/grant\s+(select|insert|update|delete|all)[^;]*\bto\s+(anon|authenticated|public)/i.test(SQL));
  assert.ok(SQL.includes('grant execute on function public.analytics_ingest(jsonb) to service_role'));
  assert.ok(SQL.includes('grant execute on function public.analytics_dashboard(int) to service_role'));
  assert.ok(/analytics_ingest[\s\S]*security definer set search_path = ''/.test(SQL));
});

test('migration: bounds, allow-list, 13-month retention, nothing scheduled', () => {
  assert.ok(SQL.includes('analytics.json_ok(props)'));
  assert.ok(/<= 8/.test(SQL) && /<= 512/.test(SQL) && />\s*40/.test(SQL));
  assert.ok(/interval '13 months'/.test(SQL));
  assert.ok(!/cron\.schedule|create extension/i.test(SQL), 'not scheduled, no extensions');
  const apps = SQL.match(/app\s+text not null check \(app in \(([^)]*)\)\)/)[1].replace(/'/g, '').split(',').map((s) => s.trim());
  assert.deepEqual(apps, SCHEMA.apps, 'table and function agree on the app list');
});

// ---------- privacy page and no third-party tags ----------
test('privacy page: the guest-ID line is verbatim, hidden by default, and the old sentence stays literally true while counts are off', () => {
  const html = read('privacy/index.html');
  assert.ok(html.includes("<p>Your guest ID isn't linked to your account.</p>"));
  assert.match(html, /<section data-analytics-copy id="guest-id" hidden>/);
  assert.match(html, /<span data-analytics-off-copy>We do not use advertising, analytics or cross-site tracking cookies\.<\/span>/);
  assert.ok(html.includes('id="anaGuestName"') && html.includes('id="anaOff"') && html.includes('id="anaReset"'));
  assert.ok(html.includes('/assets/js/bb-analytics.js'), 'the page loads the module that switches the copy');
  assert.ok(html.includes('Last updated: November 11, 2026'));
});

test('guard: counts stay OFF while the privacy copy still has a TODO', () => {
  const html = read('privacy/index.html');
  const cfg = read('assets/js/config.js');
  const enabled = /analytics:\s*\{\s*enabled:\s*true/.test(cfg);
  if (/TODO\(legal text\)/.test(html)) assert.equal(enabled, false, 'privacy copy is unfinished; do not enable analytics');
  assert.ok(/analytics:\s*\{\s*enabled:\s*false/.test(cfg) || !/TODO\(legal text\)/.test(html));
});

test('no Google, Meta or other third-party tag or SDK anywhere in the site', () => {
  const files = [];
  const walk = (d) => { for (const f of fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })) { const rel = path.join(d, f.name); if (f.isDirectory()) { if (!['.git', 'node_modules', 'tests'].includes(f.name) && !rel.startsWith('.github')) walk(rel); } else if (/\.(html|js)$/.test(f.name)) files.push(rel); } };
  walk('.');
  for (const f of files) {
    const s = read(f);
    for (const bad of ['gtag(', 'googletagmanager', 'google-analytics', 'fbq(', 'connect.facebook.net', 'facebook.com/tr', 'segment.com', 'mixpanel', 'amplitude']) assert.ok(!s.includes(bad), `${f} contains ${bad}`);
  }
});

test('public repo hygiene: no internal codes, Drive links or private emails in the new files', () => {
  const files = ['assets/js/bb-analytics.js', 'supabase/functions/events/index.ts', 'supabase/functions/events/core.js', 'supabase/functions/events/schema.js', 'supabase/migrations/20261111000000_analytics_events.sql', 'supabase/analytics/README.md', 'privacy/index.html'];
  for (const f of files) {
    const s = read(f);
    assert.ok(!/\b(BD|D|S|A)-[A-Z]*-?\d{2,4}\b/.test(s), `${f}: internal code`);
    assert.ok(!/docs\.google\.com|drive\.google\.com/.test(s), `${f}: Drive link`);
    assert.ok(!/@gmail\.com/.test(s.replace(/machinemisha@gmail\.com/g, '')), `${f}: email`);
    assert.ok(!/Nizam|Florence|Al-Jazari|Misha\b|Babar's/.test(s.replace(/A project by[^<]*/g, '')), `${f}: internal name`);
  }
});

test('privacy page script: copy switches only when counts are on', () => {
  const mk = () => ({ '[data-analytics-copy]': [{ hidden: true }], '[data-analytics-off-copy]': [{ hidden: false }] });
  const on = mk(); loadClient({ nodes: on });
  assert.equal(on['[data-analytics-copy]'][0].hidden, false);
  assert.equal(on['[data-analytics-off-copy]'][0].hidden, true);
  const off = mk(); loadClient({ enabled: false, nodes: off });
  assert.equal(off['[data-analytics-copy]'][0].hidden, true);
  assert.equal(off['[data-analytics-off-copy]'][0].hidden, false);
});
