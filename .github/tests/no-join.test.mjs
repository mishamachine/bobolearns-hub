// No-join rule tests T1 to T6 (D-078). The rule: docs/privacy/no-join-rule.md.
// Run: node --test .github/tests/no-join.test.mjs   (also run by .github/scripts/check_site.py in CI)
// T4 and T6 also run in a real Postgres engine when PGLITE_DIR is set (a folder with @electric-sql/pglite installed); otherwise those parts skip.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const walk = (dir, out = []) => {
  for (const f of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.posix.join(dir, f.name);
    if (f.isDirectory()) walk(rel, out); else out.push(rel);
  }
  return out;
};
const { SCHEMA } = await import(path.join(ROOT, 'supabase/functions/_shared/schema.js'));

const SQL_FILES = walk('supabase').filter((f) => f.endsWith('.sql'));
const FN_FILES = walk('supabase/functions').filter((f) => /\.(ts|js)$/.test(f));
const MIGRATION = read('supabase/migrations/20261111000000_analytics_events.sql');
const stripSql = (s) => s.replace(/--.*$/gm, '');
// Splits SQL into top-level statements (a new one starts at a line beginning with a keyword; function bodies are indented).
const statements = (sql) => stripSql(sql).split(/\n(?=(?:create|alter|drop|revoke|grant|comment|insert|select|update|delete|with)\b)/i);
const tables = [...stripSql(MIGRATION).matchAll(/create table if not exists analytics\.(\w+) \(([\s\S]*?)\n\);/g)]
  .map(([, name, body]) => ({
    name, body,
    cols: body.split('\n').map((l) => l.match(/^\s{2}([a-z_]+)\s+(?:uuid|text|date|int|jsonb|timestamptz)\b/)).filter(Boolean).map((m) => m[1]),
  }));
const events = tables.find((t) => t.name === 'events');

// ---------- T1 column allowlist (rule a) ----------
const RULE_A = ['anon_id', 'event', 'day', 'app', 'props']; // guest ID, event name, date, app name; props carries the content/screen identifier only
const ROW_ID = ['id']; // random uuid, not a sequence
// Fields beyond rule (a), shipped in this PR. Pending CBO sign-off: see "Known gap" in docs/privacy/no-join-rule.md.
const PENDING_CBO = ['session_id', 'platform', 'app_version', 'country', 'utm_source', 'utm_medium', 'utm_campaign', 'referrer_domain'];
const FORBIDDEN_WORDS = ['user', 'email', 'ip', 'account', 'push', 'token', 'fingerprint', 'device', 'hash', 'phone', 'name', 'member', 'profile', 'lat', 'lng'];
const FORBIDDEN = { test: (c) => c.split('_').some((w) => FORBIDDEN_WORDS.includes(w)) };
const PROP_ALLOWED = ['surface', 'auth_state', 'method', 'slug'];

test('T1 column allowlist: guest event table has exactly the rule-(a) columns plus the listed pending ones', () => {
  assert.ok(events && events.cols.length > 5, 'parsed analytics.events');
  assert.deepEqual([...events.cols].sort(), [...RULE_A.filter((c) => c !== 'props'), 'props', ...ROW_ID, ...PENDING_CBO].sort(), 'a new or removed column must be a deliberate edit of this list and of rule (a)');
  for (const c of events.cols) {
    if (c === 'anon_id') continue; // the guest ID itself
    assert.ok(!FORBIDDEN.test(c), `forbidden-looking column ${c}`);
  }
  for (const t of tables.filter((x) => x.name !== 'events')) {
    assert.ok(!t.cols.includes('anon_id') && !t.cols.includes('session_id'), `${t.name}: aggregates hold no guest ID`);
    for (const c of t.cols) assert.ok(!FORBIDDEN.test(c), `${t.name}.${c}`);
  }
  const propNames = new Set(Object.values(SCHEMA.events).flatMap((e) => Object.keys(e.props)));
  for (const p of propNames) assert.ok(PROP_ALLOWED.includes(p), `prop ${p} is not on the content/screen allowlist`);
});

// ---------- T2 no foreign keys ----------
test('T2 no foreign key from any analytics table to auth.users, profiles or any other table', () => {
  for (const f of SQL_FILES) {
    for (const st of statements(read(f))) {
      const touchesAnalytics = /analytics\./i.test(st);
      if (touchesAnalytics) assert.ok(!/\breferences\b|foreign\s+key/i.test(st), `${f}: foreign key in a statement about analytics: ${st.trim().split('\n')[0]}`);
      // and no table elsewhere may point at an analytics table
      if (!f.includes('analytics')) assert.ok(!/references\s+analytics\./i.test(st), `${f}: points at an analytics table`);
    }
  }
  assert.ok(!/\breferences\b/i.test(stripSql(MIGRATION)), 'the analytics migration has no REFERENCES at all');
});

// ---------- T3 static scan: no statement joins a guest object with an account object ----------
const GUEST_OBJ = /analytics\.(events|daily_app_stats|daily_source_stats|aggregate_runs)|analytics_ingest|analytics_dashboard|\banon_id\b|bb\.anon/i;
const ACCOUNT_OBJ = /auth\.(users|identities|sessions|refresh_tokens)|\bauth\s*\.|public\.profiles|\bprofiles\b|\baccounts?\b|user_profiles|\/auth\/v1|admin\/users|\bgetUser\b|auth\.uid\(|auth\.jwt\(/i;
export function violations(sources) {
  const bad = [];
  for (const [file, src] of Object.entries(sources)) {
    const parts = file.endsWith('.sql') ? statements(src).map((x) => x.replace(/'(?:[^']|'')*'/g, "''")) : [src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')];
    for (const p of parts) if (GUEST_OBJ.test(p) && ACCOUNT_OBJ.test(p)) bad.push(`${file}: ${p.trim().split('\n')[0].slice(0, 80)}`);
  }
  return bad;
}
test('T3 static scan of migrations, SQL, views and Edge Functions: no guest object appears with an account object', () => {
  const sources = Object.fromEntries([...SQL_FILES, ...FN_FILES].map((f) => [f, read(f)]));
  assert.ok(Object.keys(sources).length >= 6);
  assert.deepEqual(violations(sources), []);
});
test('T3 the scanner itself catches a join (self-test on bad samples)', () => {
  assert.equal(violations({ 'x.sql': 'create view v as\n select * from analytics.events e join auth.users u on u.id = e.anon_id;' }).length, 1);
  assert.equal(violations({ 'x.sql': 'create function f() returns int as $$\n select count(*) from analytics.events e, public.profiles p;\n$$ language sql;' }).length, 1);
  assert.equal(violations({ 'x.ts': 'const r = await fetch(url + "/auth/v1/user"); const t = "analytics.events"; // anon_id' }).length, 1);
  assert.equal(violations({ 'ok.sql': 'create table public.profiles (id uuid);\ncreate table analytics.events_x (id uuid); -- analytics.events' }).length, 0);
});

// ---------- T4 RLS: no read for anon or authenticated ----------
test('T4 RLS: row security on, all grants revoked from anon, authenticated and public, no policies, service role only', () => {
  const sql = stripSql(MIGRATION);
  for (const t of tables) assert.ok(sql.includes(`alter table analytics.${t.name} enable row level security`), t.name);
  assert.ok(sql.includes('revoke all on schema analytics from public, anon, authenticated'));
  assert.ok(sql.includes('revoke all on all tables in schema analytics from public, anon, authenticated'));
  assert.ok(!/create\s+policy/i.test(sql), 'no policy could open a table');
  assert.ok(!/grant\s+[^;]*\bto\s+[^;]*\b(anon|authenticated|public)\b/i.test(sql), 'no grant to app roles');
  assert.ok(!/alter\s+default\s+privileges/i.test(sql));
  for (const fn of ['public.analytics_ingest(jsonb)', 'public.analytics_dashboard(int)']) {
    assert.ok(sql.includes(`revoke all on function ${fn} from public, anon, authenticated`), fn);
    assert.ok(sql.includes(`grant execute on function ${fn} to service_role`), fn);
  }
  // rule (d): the dashboard read returns aggregates and never a guest ID
  const dash = sql.slice(sql.indexOf('create or replace function public.analytics_dashboard'));
  assert.ok(!/anon_id|session_id/.test(dash), 'dashboard function never selects a guest ID');
  assert.ok(!/analytics\.events/.test(dash), 'dashboard reads aggregates only, not raw events');
});

test('T4 in a real Postgres engine: anon and authenticated get permission denied or zero rows', { skip: !process.env.PGLITE_DIR && 'set PGLITE_DIR to run' }, async () => {
  const { PGlite } = await import(path.join(process.env.PGLITE_DIR, 'node_modules/@electric-sql/pglite/dist/index.js'));
  const db = new PGlite();
  await db.exec('create role anon; create role authenticated; create role service_role;');
  await db.exec(MIGRATION);
  await db.query('select public.analytics_ingest($1::jsonb)', [JSON.stringify([{ app: 'hub', event: 'app_open', anon_id: '3b1f9c2e-7a54-4d0b-9e21-5c8d6f0a1b23', session_id: '9d2c4e61-0f3a-4b7d-8a15-2e6b7c9d0e41', props: { surface: 'home' } }])]);
  for (const role of ['anon', 'authenticated']) {
    await db.exec(`set role ${role}`);
    for (const t of ['events', 'daily_app_stats', 'daily_source_stats', 'aggregate_runs']) {
      let rows = null;
      try { rows = (await db.query(`select * from analytics.${t}`)).rows.length; } catch (e) { rows = 'denied'; }
      assert.ok(rows === 'denied' || rows === 0, `${role} read ${t}: ${rows}`);
    }
    for (const call of ['select public.analytics_dashboard()', "select public.analytics_ingest('[]'::jsonb)"]) {
      await assert.rejects(db.query(call), /permission denied/i, `${role}: ${call}`);
    }
    await db.exec('reset role');
  }
});

// ---------- T5 client: no old guest ID after sign-in, no request with both a token and a guest ID ----------
// The test builds the page the way bb-analytics.js sees it: a sandbox with a fake storage, cookie and network.
function loadClient({ cookie = '', storage = {}, enabled = true } = {}) {
  const sent = [];
  const fetched = [];
  const mem = (init) => { const m = new Map(Object.entries(init)); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), _m: m }; };
  const local = mem(storage), sess = mem({});
  const doc = { cookie, referrer: '', addEventListener() {}, getElementById: () => null, querySelectorAll: () => [] };
  const win = {
    BOBO_CONFIG: { rootHost: 'bobolearns.com', analytics: { enabled, app: 'hub', endpoint: 'https://example.test/functions/v1/events' } },
    crypto: globalThis.crypto, localStorage: local, sessionStorage: sess,
    navigator: { doNotTrack: null, sendBeacon: (url, blob) => { sent.push({ url, blob }); return true; } },
  };
  const ctx = { window: win, document: doc, location: { pathname: '/', search: '' }, navigator: win.navigator, URL, URLSearchParams, Blob, fetch: (url, init) => { fetched.push({ url, init }); return Promise.resolve(); }, console };
  vm.runInNewContext(read('assets/js/bb-analytics.js'), ctx);
  const requests = async () => Promise.all(sent.map(async (s) => ({ url: s.url, body: JSON.parse(await s.blob.text()), text: await s.blob.text() })));
  return { api: win.bbAnalytics, local, sess, sent, fetched, requests, doc };
}
const TOKEN = 'SECRETTOKENVALUE123';
const COOKIE = `sb-ywcrzkvwamjchjjkfrve-auth-token.0=${TOKEN}`;
const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test('T5 client: after a simulated sign-in the old guest ID is deleted and never sent again', async () => {
  const guest = loadClient({});
  const [first] = await guest.requests();
  const old = first.body.anon_id;
  assert.match(old, UUID4);
  // same browser, same storage, now signed in (the session cookie appears)
  const after = loadClient({ cookie: COOKIE, storage: { 'bb.anon.v1': old } });
  after.api.track('app_open', { surface: 'home', auth_state: 'member' });
  after.api.track('guest_continue', { surface: 'home' });
  after.api.track('site_open', { slug: 'chess' });
  after.api.track('sign_in', { method: 'email', surface: 'login' });
  assert.equal(after.api.anonId(false), null, 'the old guest ID is gone from storage');
  assert.equal(after.local.getItem('bb.anon.v1'), null);
  const reqs = await after.requests();
  assert.equal(reqs.length, 1, 'only the one-off sign_in is sent; guest events stop');
  for (const r of reqs) assert.ok(!r.text.includes(old), 'no request carries the old guest ID');
  assert.notEqual(reqs[0].body.anon_id, old);
  assert.equal(reqs[0].body.events[0].event, 'sign_in');
});

test('T5 client: account-creation events never carry the stored guest ID, and the ID is not written to storage', async () => {
  const c = loadClient({});
  const [open] = await c.requests();
  const guestId = open.body.anon_id;
  c.api.track('signup_start', { method: 'email', surface: 'login' });
  c.api.track('sign_up', { auth_state: 'guest', method: 'email', surface: 'login' });
  c.api.track('guest_progress_moved', { surface: 'login' });
  const reqs = (await c.requests()).slice(1);
  assert.equal(reqs.length, 3);
  const seen = new Set();
  for (const r of reqs) {
    assert.ok(!r.text.includes(guestId), r.body.events[0].event);
    assert.match(r.body.anon_id, UUID4); assert.match(r.body.session_id, UUID4);
    assert.notEqual(r.body.session_id, open.body.session_id);
    assert.deepEqual(r.body.source, {});
    seen.add(r.body.anon_id);
  }
  assert.equal(seen.size, 3, 'a fresh ID each time, so the three cannot be matched to each other');
  assert.equal(c.api.anonId(false), guestId, 'the guest ID is unchanged for later guest events');
});

test('T5 client: no request carries both a session token and a guest ID', async () => {
  for (const cookie of ['', COOKIE]) {
    const c = loadClient({ cookie });
    for (const [e, p] of [['app_open', { surface: 'home', auth_state: 'guest' }], ['sign_in', { method: 'google', surface: 'login' }], ['sign_up', { auth_state: 'guest', method: 'email', surface: 'login' }], ['site_open', { slug: 'chess' }]]) c.api.track(e, p);
    for (const r of await c.requests()) {
      assert.ok(!r.text.includes(TOKEN) && !r.url.includes(TOKEN), 'the session token is never in a request');
      assert.ok(!/authorization|bearer|access_token|refresh_token|jwt/i.test(r.text + r.url));
      assert.ok(!/eyJ[A-Za-z0-9_-]{10,}/.test(r.text), 'no JWT-shaped value');
    }
  }
  // Source-level guarantees for the fetch fallback and the cookie: the code only tests the cookie's NAME and never sends credentials.
  const src = read('assets/js/bb-analytics.js');
  assert.ok(/credentials:\s*"omit"/.test(src), 'cross-site cookies are not sent');
  assert.ok(!/Authorization/i.test(src) && !/setRequestHeader/.test(src));
  assert.ok(!/document\.cookie\s*(?:\.|\[)?\s*(?:split|match|slice)/.test(src) && !/getSession|localStorage\.getItem\("sb-/.test(src), 'the session value is never read');
  const handler = read('supabase/functions/_shared/handler.js');
  assert.ok(!/headers\.get\('authorization'\)/i.test(handler), 'the ingest function does not read a caller token either');
  const off = loadClient({ cookie: COOKIE, enabled: false });
  assert.equal(off.sent.length, 0);
});

// ---------- T6 retention ----------
test('T6 retention: purge_raw deletes events older than N months, N equals the privacy page, scheduling is a recorded precondition', () => {
  const sql = stripSql(MIGRATION);
  const fn = sql.slice(sql.indexOf('create or replace function analytics.purge_raw'), sql.indexOf('revoke all on function analytics.purge_raw'));
  const n = Number(fn.match(/interval '(\d+) months'/)[1]);
  assert.ok(/delete from analytics\.events where day </.test(fn), 'deletes raw events by day');
  assert.ok(n >= 1 && n <= 24);
  const privacy = read('privacy/index.html');
  assert.ok(privacy.includes(`kept for ${n} months`), `the privacy page says ${n} months`);
  assert.ok(privacy.includes(`Usage-count records: ${n} months.`));
  assert.ok(/revoke all on function analytics\.purge_raw\(\) from public, anon, authenticated/.test(sql));
  const readme = read('supabase/analytics/README.md');
  assert.ok(/purge_raw/.test(readme) && /precondition/i.test(readme), 'README lists scheduling purge_raw as a precondition for enabling');
  assert.ok(!/cron\.schedule/i.test(sql), 'this PR schedules nothing: the operator step stays Babar\'s go');
});

test('T6 in a real Postgres engine: events older than N months are gone, newer stay', { skip: !process.env.PGLITE_DIR && 'set PGLITE_DIR to run' }, async () => {
  const { PGlite } = await import(path.join(process.env.PGLITE_DIR, 'node_modules/@electric-sql/pglite/dist/index.js'));
  const db = new PGlite();
  await db.exec('create role anon; create role authenticated; create role service_role;');
  await db.exec(MIGRATION);
  const n = Number(stripSql(MIGRATION).match(/interval '(\d+) months'/)[1]);
  const ins = (day) => db.query("insert into analytics.events (day, app, event, anon_id, session_id) values ($1::date, 'hub', 'app_open', gen_random_uuid(), gen_random_uuid())", [day]);
  const day = async (expr) => (await db.query(`select (${expr})::date as d`)).rows[0].d.toISOString().slice(0, 10);
  await ins(await day(`current_date - interval '${n} months' - interval '2 days'`));
  await ins(await day(`current_date - interval '${n} months' - interval '40 days'`));
  await ins(await day(`current_date - interval '${n} months' + interval '5 days'`));
  await ins(await day('current_date'));
  const removed = (await db.query('select analytics.purge_raw() as n')).rows[0].n;
  assert.equal(removed, 2);
  assert.equal((await db.query('select count(*)::int as c from analytics.events')).rows[0].c, 2);
});
