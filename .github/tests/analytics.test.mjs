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
const { SCHEMA, BANNED_PROP_WORDS } = await import(path.join(ROOT, 'supabase/functions/_shared/schema.js'));
const core = await import(path.join(ROOT, 'supabase/functions/_shared/core.js'));
const { validateBatch, propsOk, countryFrom, originAllowed, createLimiter, bannedKey, clientIp, LIMITS } = core;
const { createEventsHandler, createDashboardHandler, secretsEqual, readCapped } = await import(path.join(ROOT, 'supabase/functions/_shared/handler.js'));

const A = '3b1f9c2e-7a54-4d0b-9e21-5c8d6f0a1b23';
const S = '9d2c4e61-0f3a-4b7d-8a15-2e6b7c9d0e41';
const env = (over = {}) => ({ app: 'hub', anon_id: A, session_id: S, platform: 'web', events: [{ event: 'app_open', props: { surface: 'home', auth_state: 'guest' } }], ...over });

// ---------- the browser module, run in a sandbox ----------
function loadClient({ enabled = true, dnt = false, cookie = '', search = '', referrer = '', path: pathname = '/', storage = {}, app = 'hub', nodes = null, ids = {} } = {}) {
  const sent = [];
  const mem = (init) => { const m = new Map(Object.entries(init)); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), _m: m }; };
  const local = mem(storage), sess = mem({});
  const listeners = [];
  const win = {
    BOBO_CONFIG: { rootHost: 'bobolearns.com', analytics: { enabled, app, endpoint: 'https://example.test/functions/v1/events' } },
    crypto: globalThis.crypto, localStorage: local, sessionStorage: sess,
    navigator: { doNotTrack: dnt ? '1' : null, sendBeacon: (url, blob) => { sent.push({ url, blob }); return true; } },
  };
  const doc = { cookie, referrer, addEventListener: (t, f) => listeners.push([t, f]), querySelectorAll: (sel) => (nodes && nodes[sel]) || [], getElementById: (i) => ids[i] || null };
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
  assert.equal(validateBatch(env({ app: 'chess', events: [{ event: 'site_open', props: { slug: 'x' } }] }), null).error, 'no_valid_events', 'hub-only event');
});

test('source fields: only codes pass; junk becomes null', () => {
  const out = validateBatch(env({ source: { utm_source: 'Face book', utm_medium: 'social', utm_campaign: 'a@b.c', referrer_domain: 'https://x.com/a' }, app_version: '1.2.3' }), null);
  assert.deepEqual([out.rows[0].utm_source, out.rows[0].utm_medium, out.rows[0].utm_campaign, out.rows[0].referrer_domain, out.rows[0].app_version], [null, 'social', null, null, '1.2.3']);
});

test('origins: bobolearns.com only in production; localhost only behind the dev switch', () => {
  for (const o of ['https://bobolearns.com', 'https://woof.bobolearns.com']) assert.ok(originAllowed(o), o);
  for (const o of ['https://evil.com', 'https://bobolearns.com.evil.com', 'http://bobolearns.com', 'http://localhost:8000', 'http://127.0.0.1:8000', null, '']) assert.ok(!originAllowed(o), String(o));
  for (const o of ['http://localhost:8000', 'http://127.0.0.1']) assert.ok(originAllowed(o, true), o);
  assert.ok(!originAllowed('https://evil.com', true));
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

// ---------- the migration ----------

// ---------- prototype-chain names ----------
const PROTO = ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', 'prototype'];

test('prototype names as event or prop names are refused by the client and the server', () => {
  const { api } = loadClient({ enabled: false });
  for (const n of PROTO) {
    assert.equal(api.cleanProps(n, {}), null, `client event ${n}`);
    assert.equal(api.cleanProps('app_open', JSON.parse(`{"${n}":"x"}`)), null, `client prop ${n}`);
    assert.equal(validateBatch(env({ events: [{ event: n, props: {} }] }), null).error, 'no_valid_events', `server event ${n}`);
    assert.equal(validateBatch(env({ events: [{ event: 'app_open', props: JSON.parse(`{"${n}":"x"}`) }] }), null).error, 'no_valid_events', `server prop ${n}`);
  }
  assert.equal(validateBatch(env({ events: [{ event: { toString: 1 }, props: {} }, null, 5, 'constructor'] }), null).error, 'no_valid_events');
});

// ---------- the handler: statuses, size, rate limit ----------
const ORIGIN = 'https://bobolearns.com';
const mkEnv = (o = {}) => { const e = { SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_x', ...o }; return (k) => e[k]; };
const post = (body, headers = {}, init = {}) => new Request('https://fn.test/events', { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'text/plain', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body), ...init });
function mkHandler({ env = mkEnv(), limiter, fetchImpl } = {}) {
  const calls = [];
  const f = fetchImpl || (async (u, i) => { calls.push({ u, i }); return new Response('1', { status: 200 }); });
  const lim = limiter || createLimiter({ secret: 't' });
  return { h: createEventsHandler({ limiter: lim, env, fetch: async (u, i) => { calls.push({ u, i }); return f(u, i); } }), calls };
}

test('handler: prototype-chain names give a clean 400, never a 500 or 502, and nothing reaches the database', async () => {
  const { h, calls } = mkHandler();
  for (const n of PROTO) {
    for (const body of [env({ events: [{ event: n, props: {} }] }), env({ events: [{ event: 'app_open', props: JSON.parse(`{"${n}":"x"}`) }] }), env({ app: n })]) {
      const r = await h(post(body));
      assert.equal(r.status, 400, n);
    }
  }
  assert.equal((await h(post('{"__proto__":{"app":"hub"}}'))).status, 400);
  assert.equal(calls.length, 0);
});

test('handler: a good request inserts through the RPC with a country and no IP', async () => {
  const { h, calls } = mkHandler();
  const r = await h(post(env(), { 'cf-ipcountry': 'ca', 'cf-connecting-ip': '203.0.113.9' }));
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, n: 1, rejected: 0 });
  assert.equal(calls[0].u, 'https://db.test/rest/v1/rpc/analytics_ingest');
  const sent = JSON.parse(calls[0].i.body);
  assert.equal(sent.p_rows[0].country, 'CA');
  assert.ok(!JSON.stringify(sent).includes('203.0.113.9'));
  assert.equal((await h(post(env(), { origin: 'https://evil.com' }))).status, 403);
  assert.equal((await h(new Request('https://fn.test/events', { method: 'GET', headers: { origin: ORIGIN } }))).status, 405);
  const bad = mkHandler({ fetchImpl: async () => new Response('x', { status: 500 }) });
  assert.equal((await bad.h(post(env()))).status, 502);
});

test('handler: localhost origins are refused unless the dev switch is set', async () => {
  const { h } = mkHandler();
  assert.equal((await h(post(env(), { origin: 'http://localhost:8000' }))).status, 403);
  const dev = mkHandler({ env: mkEnv({ EVENTS_DEV_ORIGINS: '1' }) });
  assert.equal((await dev.h(post(env(), { origin: 'http://localhost:8000' }))).status, 200);
});

test('handler: a declared length over 8192 is refused before any byte is read', async () => {
  let pulled = false;
  const body = new ReadableStream({ pull() { pulled = true; } }, { highWaterMark: 0 });
  const { h } = mkHandler();
  const r = await h(new Request('https://fn.test/events', { method: 'POST', headers: { origin: ORIGIN, 'content-length': String(LIMITS.maxBody + 1) }, body, duplex: 'half' }));
  assert.equal(r.status, 413);
  assert.equal(pulled, false, 'the body stream was never read');
});

test('handler: a streamed body with no length is cut off at 8192 bytes', async () => {
  let sent = 0;
  const chunk = new Uint8Array(1024).fill(97);
  const body = new ReadableStream({ pull(c) { if (sent >= 64) return c.close(); sent++; c.enqueue(chunk); } });
  const { h } = mkHandler();
  const r = await h(new Request('https://fn.test/events', { method: 'POST', headers: { origin: ORIGIN }, body, duplex: 'half' }));
  assert.equal(r.status, 413);
  assert.ok(sent <= 12, `read ${sent} KB of 64`);
  assert.equal(await readCapped(post('x'.repeat(LIMITS.maxBody)), LIMITS.maxBody).then((t) => t.length), LIMITS.maxBody, 'exactly the cap is fine');
  assert.equal(await readCapped(post('x'.repeat(LIMITS.maxBody + 1)), LIMITS.maxBody), null);
});

test('rate limit uses only the platform client-IP header; a spoofed x-forwarded-for changes nothing', async () => {
  const lim = createLimiter({ secret: 't', perMinute: 3 });
  const { h } = mkHandler({ limiter: lim });
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push((await h(post(env(), { 'cf-connecting-ip': '198.51.100.1', 'x-forwarded-for': `10.0.0.${i}, 1.1.1.1` }))).status);
  assert.deepEqual(codes, [200, 200, 200, 429, 429], 'rotating the leftmost x-forwarded-for does not escape the limit');
  assert.equal((await h(post(env(), { 'cf-connecting-ip': '198.51.100.2' }))).status, 200, 'another client has its own bucket');
  const h2 = new Headers({ 'x-forwarded-for': '9.9.9.9' });
  assert.equal(clientIp(h2), 'no-ip', 'x-forwarded-for is never read');
  assert.equal(clientIp(new Headers({ 'cf-connecting-ip': '1.2.3.4' })), '1.2.3.4');
});

test('limiter table: expired entries are evicted first, then the least recent; the cap never resets everyone', async () => {
  let t = Date.parse('2026-11-11T12:00:00Z');
  const lim = createLimiter({ secret: 't', now: () => t, perMinute: 2, maxTracked: 4 });
  for (let i = 0; i < 3; i++) await lim.limited('hot'); // over the limit
  for (const ip of ['a', 'b', 'c']) await lim.limited(ip);
  assert.equal(lim.size(), 4);
  await lim.limited('hot'); // refresh: hot is now the most recent
  for (const ip of ['d', 'e', 'f']) await lim.limited(ip); // overflow: oldest go, never all
  assert.equal(lim.size(), 4, 'bounded, not cleared');
  assert.equal(await lim.limited('hot'), true, 'a busy client is still limited after the table overflowed');
  t += 61_000; // everything expires
  await lim.limited('z');
  assert.equal(lim.size(), 1, 'expired entries are swept');
});

// ---------- no time of day, no sign-up to device link ----------
const ONE_OFF = ['signup_start', 'sign_up', 'sign_in', 'guest_progress_moved'];
const FULL = env({ app_version: '1.2.3', source: { utm_source: 'facebook', utm_medium: 'social', utm_campaign: 'spring', referrer_domain: 'news.example.org' } });

test('account-creation events keep only event, app, page area and fresh random IDs; nothing else survives', () => {
  const out = validateBatch({ ...FULL, events: [
    { event: 'app_open', props: { surface: 'home', auth_state: 'guest' } },
    { event: 'signup_start', props: { method: 'google', surface: 'login' } },
    { event: 'sign_up', props: { auth_state: 'guest', method: 'email', surface: 'login' } },
    { event: 'sign_in', props: { method: 'apple', surface: 'login' } },
    { event: 'guest_progress_moved', props: { surface: 'login' } },
    { event: 'sign_up', props: { auth_state: 'guest', method: 'email' } },
  ] }, 'US');
  const normal = out.rows.find((r) => r.event === 'app_open');
  assert.equal(normal.anon_id, A);
  assert.equal(normal.country, 'US');
  assert.equal(normal.utm_source, 'facebook');
  assert.equal(normal.platform, 'web');
  const oneOff = out.rows.filter((r) => ONE_OFF.includes(r.event));
  assert.equal(oneOff.length, 5);
  const ids = new Set();
  for (const r of oneOff) {
    assert.deepEqual(Object.keys(r).sort(), ['anon_id', 'app', 'app_version', 'country', 'event', 'platform', 'props', 'referrer_domain', 'session_id', 'utm_campaign', 'utm_medium', 'utm_source']);
    for (const k of ['platform', 'app_version', 'country', 'utm_source', 'utm_medium', 'utm_campaign', 'referrer_domain']) assert.strictEqual(r[k], null, `${r.event}.${k}`);
    assert.ok(Object.keys(r.props).every((k) => k === 'surface'), `${r.event} props: ${JSON.stringify(r.props)}`);
    assert.notEqual(r.anon_id, A); assert.notEqual(r.session_id, S);
    assert.match(r.anon_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    ids.add(r.anon_id); ids.add(r.session_id);
  }
  assert.equal(ids.size, 10, 'every one-off ID is unique');
  const text = JSON.stringify(oneOff);
  for (const bad of [A, S, 'google', 'apple', 'email', 'auth_state', 'method', 'facebook', 'spring', 'news.example.org', '1.2.3', '"US"', 'web']) assert.ok(!text.includes(bad), `a one-off row still holds ${bad}`);
  assert.deepEqual(oneOff[0].props, { surface: 'login' });
  assert.deepEqual(oneOff[4].props, {}, 'no surface sent, none stored');
  for (const r of out.rows) assert.deepEqual(Object.keys(r).filter((k) => /time|ts$|created|at$/.test(k)), [], 'no timestamp field in a row');
});

test('utm values: codes only, nothing with an @ or that looks like an email', () => {
  const mk = (v) => validateBatch(env({ source: { utm_source: v, utm_medium: v, utm_campaign: v, referrer_domain: v } }), null).rows[0];
  for (const bad of ['a@b.c', 'user@example.com', 'x@y', '@handle', 'UPPER', 'has space', '']) {
    const r = mk(bad);
    assert.deepEqual([r.utm_source, r.utm_medium, r.utm_campaign, r.referrer_domain], [null, null, null, null], bad);
  }
  const long = mk('a'.repeat(41));
  assert.deepEqual([long.utm_source, long.utm_medium, long.utm_campaign], [null, null, null], 'codes are at most 40 characters');
  const ok = mk('spring_sale-24');
  assert.deepEqual([ok.utm_source, ok.utm_medium, ok.utm_campaign], ['spring_sale-24', 'spring_sale-24', 'spring_sale-24']);
});

// ---------- the dashboard read function ----------
test('analytics-dashboard function: constant-time secret, GET only, fails closed, passes the aggregates through', async () => {
  const SECRET = 's'.repeat(32);
  const calls = [];
  const agg = { generated_at: 'x', apps: [] };
  const mk = (e = {}) => createDashboardHandler({ env: mkEnv({ ANALYTICS_DASHBOARD_SECRET: SECRET, ...e }), fetch: async (u, i) => { calls.push({ u, i }); return new Response(JSON.stringify(agg), { status: 200 }); } });
  const get = (headers = {}, method = 'GET') => new Request('https://fn.test/analytics-dashboard', { method, headers });
  const h = mk();
  assert.equal((await h(get())).status, 401);
  assert.equal((await h(get({ 'x-dashboard-secret': 'wrong' }))).status, 401);
  assert.equal((await h(get({ 'x-dashboard-secret': SECRET.slice(0, -1) }))).status, 401);
  assert.equal((await h(get({ 'x-dashboard-secret': SECRET }, 'POST'))).status, 405);
  assert.equal(calls.length, 0, 'no database call without the secret');
  const ok = await h(get({ 'x-dashboard-secret': SECRET }));
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), agg);
  assert.equal(calls[0].u, 'https://db.test/rest/v1/rpc/analytics_dashboard');
  assert.equal(ok.headers.get('access-control-allow-origin'), null, 'no CORS: server to server only');
  assert.equal((await mk({ ANALYTICS_DASHBOARD_SECRET: '' })(get({ 'x-dashboard-secret': '' }))).status, 503, 'unset secret fails closed');
  assert.equal((await mk({ ANALYTICS_DASHBOARD_SECRET: 'short' })(get({ 'x-dashboard-secret': 'short' }))).status, 503, 'weak secret fails closed');
  assert.equal(await secretsEqual('abc', 'abc'), true);
  assert.equal(await secretsEqual('abc', 'abd'), false);
  assert.equal(await secretsEqual('', ''), true);
});

test('function sources: RPC only, no direct table writes, never x-forwarded-for, never logs an IP', () => {
  const src = ['supabase/functions/_shared/handler.js', 'supabase/functions/_shared/core.js', 'supabase/functions/events/index.ts', 'supabase/functions/analytics-dashboard/index.ts'].map(read).join('\n');
  assert.ok(src.includes('/rest/v1/rpc/analytics_ingest') && src.includes('/rest/v1/rpc/analytics_dashboard'));
  assert.ok(!/rest\/v1\/(?!rpc)/.test(src), 'no direct table REST writes');
  assert.ok(!/x-forwarded-for/i.test(src.replace(/\/\/.*$/gm, '')), 'x-forwarded-for is only mentioned in comments');
  assert.ok(!/console\.(log|info|warn|error)\([^)]*\bip\b/.test(src));
  assert.ok(!/body: JSON\.stringify\([^)]*\bip\b/.test(src));
  assert.ok(src.includes('countryFrom(req.headers)'));
});

// ---------- the migration ----------
const SQL = read('supabase/migrations/20261111000000_analytics_events.sql');
const tableBodies = [...SQL.matchAll(/create table if not exists analytics\.(\w+) \(([\s\S]*?)\n\);/g)];
const eventsBody = tableBodies.find(([, n]) => n === 'events')[2];

test('migration: no user_id, email, name or IP column in any analytics table', () => {
  assert.ok(tableBodies.length >= 4);
  for (const [, name, body] of tableBodies) for (const col of ['user_id', 'email', 'name', 'ip', 'ip_address', 'lat', 'lng', 'account_id']) {
    assert.ok(!new RegExp(`^\\s+${col}\\s`, 'm').test(body), `${name} has column ${col}`);
  }
  assert.ok(!/references\s+auth\.users/i.test(SQL), 'no link to accounts');
});

test('migration: raw events store a day only: no timestamp column, no sequence order', () => {
  assert.ok(!/timestamp/i.test(eventsBody), 'no timestamp or timestamptz column in analytics.events');
  assert.ok(/^\s+day\s+date not null/m.test(eventsBody));
  assert.ok(!/^\s+created_at\b/m.test(eventsBody));
  assert.ok(/^\s+id\s+uuid primary key default gen_random_uuid\(\)/m.test(eventsBody), 'random row id, so insertion order is not kept');
  assert.ok(!/generated always as identity|serial/i.test(eventsBody));
  const ingest = SQL.slice(SQL.indexOf('create or replace function public.analytics_ingest'), SQL.indexOf('revoke all on function public.analytics_ingest'));
  const oo = "r.event in ('sign_up', 'sign_in', 'signup_start', 'guest_progress_moved')";
  assert.ok(ingest.includes(`when ${oo} then gen_random_uuid() else r.anon_id`), 'the database also replaces the device ID on all four events');
  assert.ok(ingest.includes(`when ${oo} then gen_random_uuid() else r.session_id`));
  for (const col of ['platform', 'app_version', 'country', 'utm_source', 'utm_medium', 'utm_campaign', 'referrer_domain']) assert.ok(ingest.includes(`when ${oo} then null else r.${col}`), `${col} is nulled in the database`);
  assert.ok(ingest.includes("jsonb_build_object('surface', r.props -> 'surface')"), 'only the page area survives in props');
  const agg = SQL.slice(SQL.indexOf('analytics.aggregate_day(p_day date)'), SQL.indexOf('analytics.purge_raw()'));
  assert.ok(/event not in \('sign_up', 'sign_in', 'signup_start', 'guest_progress_moved'\) group by app, anon_id/.test(agg), 'users are counted without the one-off rows');
  assert.ok(/^\s+platform\s+text check \(platform is null or/m.test(eventsBody), 'platform may be null');
  assert.ok(!/created_at/.test(SQL.replace(/--.*$/gm, '')));
});

test('migration: RLS on, no grants to anon or authenticated, ingest only for the service role', () => {
  for (const t of ['events', 'daily_app_stats', 'daily_source_stats', 'aggregate_runs']) assert.ok(SQL.includes(`alter table analytics.${t} enable row level security`), t);
  assert.ok(SQL.includes('revoke all on all tables in schema analytics from public, anon, authenticated'));
  assert.ok(!/create\s+policy/i.test(SQL), 'no policies');
  assert.ok(!/grant\s+(select|insert|update|delete|all)[^;]*\bto\s+(anon|authenticated|public)/i.test(SQL));
  assert.ok(SQL.includes('grant execute on function public.analytics_ingest(jsonb) to service_role'));
  assert.ok(SQL.includes('grant execute on function public.analytics_dashboard(int) to service_role'));
});

test('migration: every function pins search_path; bounds; 14-month retention; nothing scheduled', () => {
  const fns = [...SQL.matchAll(/create or replace function ([\w.]+)\([\s\S]*?\n(?:\$\$|end \$\$);/g)].map((m) => m[0]);
  assert.ok(fns.length >= 5);
  for (const f of fns) assert.ok(/set search_path = ''/.test(f), f.split('\n')[0]);
  assert.ok(SQL.includes('analytics.json_ok(props)'));
  assert.ok(/<= 8/.test(SQL) && /<= 512/.test(SQL) && />\s*40/.test(SQL));
  assert.ok(/interval '14 months'/.test(SQL) && !/13 months/.test(SQL));
  assert.ok(!/cron\.schedule|create extension/i.test(SQL), 'not scheduled, no extensions');
  const apps = SQL.match(/app\s+text not null check \(app in \(([^)]*)\)\)/)[1].replace(/'/g, '').split(',').map((s) => s.trim());
  assert.deepEqual(apps, SCHEMA.apps, 'table and function agree on the app list');
});

// ---------- privacy page ----------
// The final privacy wording lives HERE, once. A change in wording is one edit to this list and one edit to privacy/index.html.
const PRIVACY_HEADING = 'Guest ID and usage counts';
const PRIVACY_OFF_LINE = 'Usage counts are currently off.';
const PRIVACY_PARAGRAPHS = [
  `When usage counts are on, our server records simple events on bobolearns.com, such as opening a page, starting sign-up or signing in, so we can see what is useful. Most events have a random ID for this browser, the date, the page area, whether you were signed in, where the visit came from (for example a search engine or a link we posted) and your country. Sign-up, sign-in and progress-moving events instead get a separate one-off ID and keep only the date and page area, so they aren't stored with your guest ID.`,
  `The random ID, and a made-up name made from it (for example "Guest Brave-Otter-4821"), are kept in this browser's local storage. They are not made from your IP address and mean nothing outside our tools.`,
  `We use your IP address only to work out your country and, briefly, to stop abuse. We don't store it in our analytics or guest IDs. Our hosting and database providers keep standard security logs, described above.`,
  `Your guest ID isn't linked to your account.`,
  `Event records, including the random ID, are kept for 14 months. Daily totals that contain no IDs may be kept longer.`,
  `You can turn usage counts off on this device or reset your guest ID with the controls below, or clear this site's data in your browser. If your browser sends Do Not Track or Global Privacy Control, we don't count your visits.`,
];
const sectionOf = (html) => html.slice(html.indexOf('<section id="guest-id">'), html.indexOf('</section>', html.indexOf('<section id="guest-id">')));

test('privacy page: the passed wording is in the static HTML, pinned in order, and needs no JavaScript', () => {
  const html = read('privacy/index.html');
  const sec = sectionOf(html);
  assert.ok(sec.includes(`<h2>${PRIVACY_HEADING}</h2>`));
  assert.ok(sec.includes(`<p><strong>${PRIVACY_OFF_LINE}</strong></p>`));
  let at = sec.indexOf(PRIVACY_OFF_LINE);
  for (const para of PRIVACY_PARAGRAPHS) {
    const i = sec.indexOf(`<p>${para}</p>`, at);
    assert.ok(i > at, `missing or out of order: ${para.slice(0, 50)}`);
    at = i;
  }
  assert.ok(!/\bhidden\b|data-analytics/.test(html), 'nothing hides or swaps text with script');
  assert.ok(!/TODO/i.test(html), 'no TODO left');
  assert.ok(html.includes('We do not use advertising, analytics or cross-site tracking cookies.'), 'the cookie sentence is always visible');
  for (const label of ['Guest name on this device:', 'Turn off usage counts on this device', 'Reset my guest ID']) assert.ok(sec.includes(label), label);
  assert.ok(html.includes('id="anaGuestName"') && html.includes('id="anaOff"') && html.includes('id="anaReset"'));
  assert.ok(html.includes('/assets/js/bb-analytics.js'));
});

const cfgSource = read('assets/js/config.js');
const parseCfg = () => { const w = {}; vm.runInNewContext(cfgSource, { window: w }); return w.BOBO_CONFIG; };

test('config: analytics.enabled is exactly false in this PR (parsed, not pattern-matched)', () => {
  assert.strictEqual(parseCfg().analytics.enabled, false);
});

test('the page stays true in both states: while off it says so; if a later PR turns counts on it must change those lines', () => {
  const html = read('privacy/index.html');
  const on = parseCfg().analytics.enabled === true;
  if (on) {
    assert.ok(!html.includes(PRIVACY_OFF_LINE), 'counts are on: remove the "currently off" line');
    assert.ok(!html.includes('advertising, analytics or cross-site tracking cookies'), 'counts are on: remove "analytics" from the no-analytics sentence');
  } else {
    assert.ok(html.includes(PRIVACY_OFF_LINE));
    assert.ok(html.includes('advertising, analytics or cross-site tracking cookies'));
  }
});

test('README lists the exact static edits and the preconditions for enabling', () => {
  const r = read('supabase/analytics/README.md');
  for (const needle of ['not recorded by method, source or country', '"<5"', 'Usage counts are currently off.', 'We do not use advertising, analytics or cross-site tracking cookies.', 'We do not use advertising or cross-site tracking cookies.', 'aggregate_day', 'purge_raw', 'precondition', 'cf-connecting-ip', 'unverified', 'ANALYTICS_DASHBOARD_SECRET']) assert.ok(r.includes(needle), needle);
});

test('privacy controls work with the flag off: guest name, off switch and reset', () => {
  const name = { textContent: '' }, off = { checked: false, listeners: {}, addEventListener(t, f) { this.listeners[t] = f; } }, rst = { listeners: {}, addEventListener(t, f) { this.listeners[t] = f; } };
  const c = loadClient({ enabled: false, ids: { anaGuestName: name, anaOff: off, anaReset: rst }, storage: { 'bb.anon.v1': A } });
  assert.equal(name.textContent, 'Guest Jolly-Quokka-5243');
  off.checked = true; off.listeners.change();
  assert.equal(c.local.getItem('bb.analytics.off'), '1');
  assert.equal(c.local.getItem('bb.anon.v1'), null, 'turning off also forgets the ID');
  assert.equal(name.textContent, 'none yet');
});

// ---------- no third-party tags; public-repo hygiene ----------
test('no Google, Meta or other third-party tag or SDK anywhere in the site', () => {
  const files = [];
  const walk = (d) => { for (const f of fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })) { const rel = path.join(d, f.name); if (f.isDirectory()) { if (!['.git', 'node_modules', 'tests'].includes(f.name) && !rel.startsWith('.github')) walk(rel); } else if (/\.(html|js)$/.test(f.name)) files.push(rel); } };
  walk('.');
  for (const f of files) {
    const s = read(f);
    for (const bad of ['gtag(', 'googletagmanager', 'google-analytics', 'fbq(', 'connect.facebook.net', 'facebook.com/tr', 'segment.com', 'mixpanel', 'amplitude']) assert.ok(!s.includes(bad), `${f} contains ${bad}`);
  }
});

test('public repo hygiene: no internal codes, Drive links, private emails or internal names in the new files or this test', () => {
  const names = new RegExp([['Ni', 'zam'], ['Flor', 'ence'], ['Al-', 'Jazari'], ['Mis', 'ha\\b'], ['Bab', "ar's"], ['Zir', 'yab'], ['Ibn ', 'Sina']].map((p) => p.join('')).join('|'));
  const files = ['assets/js/bb-analytics.js', 'supabase/functions/events/index.ts', 'supabase/functions/_shared/core.js', 'supabase/functions/_shared/handler.js', 'supabase/functions/_shared/schema.js', 'supabase/functions/analytics-dashboard/index.ts', 'supabase/migrations/20261111000000_analytics_events.sql', 'supabase/analytics/README.md', 'privacy/index.html', '.github/tests/analytics.test.mjs'];
  for (const f of files) {
    const s = read(f);
    assert.ok(!/\b(BD|D|S|A)-[A-Z]*-?\d{2,4}\b/.test(s), `${f}: internal code`);
    assert.ok(!/docs\.google\.com|drive\.google\.com/.test(s), `${f}: Drive link`);
    assert.ok(!/@gmail\.com/.test(s.replace(/machinemisha@gmail\.com/g, '')), `${f}: email`);
    assert.ok(!names.test(s.replace(/A project by[^<]*/g, '')), `${f}: internal name`);
  }
});

// ---------- the migration, run in a real Postgres engine (PGlite) ----------
// PGlite is not a dependency of this repo. Run locally with PGLITE_DIR=<a folder with @electric-sql/pglite installed>;
// without it the test is skipped (CI does not have it).
test('migration in PGlite: one-off rows are stripped, users exclude them, small cells are hidden', { skip: !process.env.PGLITE_DIR && 'set PGLITE_DIR to run' }, async () => {
  const { PGlite } = await import(path.join(process.env.PGLITE_DIR, 'node_modules/@electric-sql/pglite/dist/index.js'));
  const db = new PGlite();
  await db.exec('create role anon; create role authenticated; create role service_role;');
  await db.exec(SQL);
  const U = Array.from({ length: 12 }, (_, i) => `${String(i + 1).padStart(8, '0')}-1111-4111-8111-111111111111`);
  const SS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const mk = (anon, event, props = {}, extra = {}) => ({ app: 'hub', event, anon_id: anon, session_id: SS, platform: 'web', app_version: '1.0', country: 'US', utm_source: 'facebook', utm_medium: 'social', utm_campaign: 'c', referrer_domain: 'x.com', props, ...extra });
  const rows = [];
  for (let i = 0; i < 12; i++) rows.push(mk(U[i], 'app_open', { surface: 'home', auth_state: 'guest' }, i < 8 ? {} : { utm_source: null, referrer_domain: null }));
  for (let i = 0; i < 12; i++) rows.push(mk(U[i], 'site_open', { slug: 'chess' }));
  for (let i = 0; i < 3; i++) rows.push(mk(U[i], 'signup_start', { method: 'google', surface: 'login' }));
  rows.push(mk(U[0], 'sign_up', { auth_state: 'guest', method: 'email', surface: 'login' }), mk(U[1], 'sign_up', { auth_state: 'guest', method: 'google', surface: 'login' }));
  rows.push(mk(U[2], 'sign_in', { method: 'email', surface: 'login' }), mk(U[3], 'guest_progress_moved', { surface: 'login' }));
  rows.push(mk(U[11], 'app_open', { surface: 'home' }, { utm_source: 'tiny', referrer_domain: null })); // a source with 1 visit
  await db.query('select public.analytics_ingest($1::jsonb)', [JSON.stringify(rows)]);

  const one = (await db.query(`select * from analytics.events where event in ('sign_up','sign_in','signup_start','guest_progress_moved')`)).rows;
  assert.equal(one.length, 7);
  for (const r of one) {
    for (const c of ['platform', 'app_version', 'country', 'utm_source', 'utm_medium', 'utm_campaign', 'referrer_domain']) assert.strictEqual(r[c], null, `${r.event}.${c}`);
    assert.ok(!U.includes(r.anon_id) && r.session_id !== SS);
    assert.ok(Object.keys(r.props).every((k) => k === 'surface'), JSON.stringify(r.props));
  }
  assert.equal(new Set(one.flatMap((r) => [r.anon_id, r.session_id])).size, 14);
  const keep = (await db.query(`select * from analytics.events where event = 'app_open' limit 1`)).rows[0];
  assert.equal(keep.country, 'US');

  await db.exec('select analytics.aggregate_day(current_date)');
  const stats = (await db.query('select * from analytics.daily_app_stats')).rows[0];
  assert.equal(stats.dau, 12, 'users are counted without the one-off rows');
  assert.equal(stats.signups_1d, 2);
  assert.equal(stats.funnel_signup_start, 3, 'signup_start counted as events');

  const d = (await db.query('select public.analytics_dashboard() d')).rows[0].d;
  const app = d.apps[0];
  assert.equal(app.dau, 12); assert.equal(app.wau, 12); assert.equal(app.mau, 12);
  assert.equal(app.signups_1d, '<5'); assert.equal(app.funnel_signup_start, '<5'); assert.equal(app.funnel_sign_up, '<5'); assert.equal(app.signins_1d, '<5');
  assert.equal(app.funnel_app_open, 12); assert.equal(app.funnel_guest, 0, 'zero is shown as zero');
  assert.deepEqual(app.top_events, [{ event: 'site_open', n: 12 }]);
  const src = Object.fromEntries(d.sources.map((s) => [s.source, s.visits]));
  assert.equal(src.facebook, 8);
  assert.ok(!('tiny' in src) && !('direct' in src), 'sources under 5 are folded, not listed');
  assert.equal(src.other, 5, 'direct (4) and tiny (1) fold into other');
});

test('requests with no IP skip the per-IP table and share a high global cap', async () => {
  let t = 1_000_000;
  const lim = createLimiter({ secret: 't', now: () => t, perMinute: 2, noIpPerMinute: 5 });
  const res = [];
  for (let i = 0; i < 7; i++) res.push(await lim.limited('no-ip'));
  assert.deepEqual(res, [false, false, false, false, false, true, true], 'per-IP limit of 2 does not apply; global cap of 5 does');
  assert.equal(lim.size(), 0, 'no per-IP entry was made');
  assert.equal(await lim.limited('203.0.113.9'), false, 'a real address is unaffected');
  t += 61_000;
  assert.equal(await lim.limited('no-ip'), false, 'the window slides');
});
