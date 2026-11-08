// Run: node --test supabase/functions/confirm-age/handler.test.ts  (Node 22.6+ strips the types)
import test from "node:test";
import assert from "node:assert/strict";
import { handle, AGE_RULE_VERSION, USER_TABLES } from "./handler.ts";
import type { CallerUser } from "./handler.ts";

const NOW = new Date("2026-11-07T12:00:00.000Z");

function setup(user: CallerUser | null, opts: { writeError?: string; throwOnGet?: boolean; failTable?: string; missing?: string[]; authDeleteError?: string } = {}) {
  const writes: Array<{ id: string; metadata: Record<string, unknown> }> = [];
  const log: string[] = [];
  // Fake database: rows per table for two users, so "only this user's rows go" can be checked.
  const db: Record<string, Array<{ user_id: string }>> = {};
  for (const t of USER_TABLES) db[t] = [{ user_id: "u1" }, { user_id: "u1" }, { user_id: "other" }];
  const authUsers = new Set(["u1", "other"]);
  const deps = {
    now: () => NOW,
    getUser: async (_jwt: string) => {
      if (opts.throwOnGet) throw new Error("bad jwt");
      return user;
    },
    deleteUserRows: async (table: string, id: string) => {
      log.push("rows:" + table);
      if (opts.missing?.includes(table)) return { error: "relation does not exist", missingTable: true };
      if (table === opts.failTable) return { error: "db down" };
      db[table] = db[table].filter((r) => r.user_id !== id);
      return { error: null };
    },
    deleteAuthUser: async (id: string) => {
      log.push("auth");
      if (opts.authDeleteError) return { error: opts.authDeleteError };
      authUsers.delete(id);
      return { error: null };
    },
    setAppMetadata: async (id: string, metadata: Record<string, unknown>) => {
      writes.push({ id, metadata });
      return { error: opts.writeError ?? null };
    },
  };
  return { deps, writes, log, db, authUsers };
}
const post = (headers: Record<string, string> = { authorization: "Bearer tok" }, body = "{}") =>
  new Request("https://x.test/confirm-age", { method: "POST", headers, body });

test("signed-in user: flag set for that user only, with server time and rule version", async () => {
  const { deps, writes } = setup({ id: "u1", app_metadata: { provider: "google", providers: ["google"] } });
  const res = await handle(post(), deps);
  assert.equal(res.status, 200);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].id, "u1");
  assert.deepEqual(writes[0].metadata, {
    provider: "google", providers: ["google"],
    age_confirmed_at: NOW.toISOString(), age_rule_version: AGE_RULE_VERSION,
  });
});

test("client-supplied body cannot choose the user, time or version", async () => {
  const { deps, writes } = setup({ id: "u1" });
  const body = JSON.stringify({ user_id: "victim", age_confirmed_at: "2000-01-01", age_rule_version: "x" });
  await handle(post({ authorization: "Bearer tok" }, body), deps);
  assert.equal(writes[0].id, "u1");
  assert.equal(writes[0].metadata.age_confirmed_at, NOW.toISOString());
  assert.equal(writes[0].metadata.age_rule_version, AGE_RULE_VERSION);
});

test("no Authorization header: 401, nothing written", async () => {
  const { deps, writes } = setup({ id: "u1" });
  const res = await handle(post({}), deps);
  assert.equal(res.status, 401);
  assert.equal(writes.length, 0);
});

test("JWT with no user (publishable key) or invalid JWT: 401, nothing written", async () => {
  for (const o of [{ user: null }, { user: { id: "u1" }, throwOnGet: true }]) {
    const { deps, writes } = setup(o.user, { throwOnGet: o.throwOnGet });
    const res = await handle(post(), deps);
    assert.equal(res.status, 401);
    assert.equal(writes.length, 0);
  }
});

test("anonymous session: 401, nothing written", async () => {
  const { deps, writes } = setup({ id: "anon1", is_anonymous: true });
  const res = await handle(post(), deps);
  assert.equal(res.status, 401);
  assert.equal(writes.length, 0);
});

test("write failure: 500 without leaking the error text", async () => {
  const { deps } = setup({ id: "u1" }, { writeError: "secret db detail" });
  const res = await handle(post(), deps);
  assert.equal(res.status, 500);
  assert.ok(!(await res.text()).includes("secret"));
});

test("GET is rejected; OPTIONS preflight answers only for Bobo origins", async () => {
  const { deps, writes } = setup({ id: "u1" });
  assert.equal((await handle(new Request("https://x.test/", { method: "GET" }), deps)).status, 405);
  const ok = await handle(new Request("https://x.test/", { method: "OPTIONS", headers: { origin: "https://lingo.bobolearns.com" } }), deps);
  assert.equal(ok.status, 204);
  assert.equal(ok.headers.get("access-control-allow-origin"), "https://lingo.bobolearns.com");
  const bad = await handle(new Request("https://x.test/", { method: "OPTIONS", headers: { origin: "https://evilbobolearns.com" } }), deps);
  assert.equal(bad.headers.get("access-control-allow-origin"), null);
  assert.equal(writes.length, 0);
});

const decline = (headers: Record<string, string> = { authorization: "Bearer tok" }, body: unknown = { action: "decline" }) =>
  post(headers, JSON.stringify(body));

test("decline: deletes this user's rows in every listed table, then the auth user; others untouched; no flag written", async () => {
  const { deps, writes, log, db, authUsers } = setup({ id: "u1" });
  const res = await handle(decline(), deps);
  assert.equal(res.status, 200);
  for (const t of USER_TABLES) {
    assert.deepEqual(db[t], [{ user_id: "other" }], t);
  }
  assert.deepEqual(log, [...USER_TABLES.map((t) => "rows:" + t), "auth"]); // auth user last
  assert.equal(authUsers.has("u1"), false);
  assert.equal(authUsers.has("other"), true);
  assert.equal(writes.length, 0); // nothing recorded about the answer
});

test("decline: the table list covers the live user tables and the pending ones", () => {
  for (const t of ["user_progress", "saved_lessons", "daily_activity", "user_settings", "consent_log", "site_events"]) {
    assert.ok(USER_TABLES.includes(t), t);
  }
});

test("decline: a failure part-way leaves the auth user in place and stops", async () => {
  const { deps, log, authUsers } = setup({ id: "u1" }, { failTable: "daily_activity" });
  const res = await handle(decline(), deps);
  assert.equal(res.status, 500);
  assert.equal(authUsers.has("u1"), true);
  assert.ok(!log.includes("auth"));
  assert.ok(!log.includes("rows:consent_log")); // stopped at the failure
});

test("decline: a table that does not exist yet is skipped; a failed auth delete is an error", async () => {
  const a = setup({ id: "u1" }, { missing: ["consent_log", "site_events"] });
  assert.equal((await handle(decline(), a.deps)).status, 200);
  assert.equal(a.authUsers.has("u1"), false);
  const b = setup({ id: "u1" }, { authDeleteError: "nope" });
  assert.equal((await handle(decline(), b.deps)).status, 500);
});

test("decline: no JWT, no-user JWT or anonymous session deletes nothing", async () => {
  for (const o of [{ h: {} as Record<string, string>, u: { id: "u1" } as CallerUser | null }, { h: { authorization: "Bearer tok" }, u: null }, { h: { authorization: "Bearer tok" }, u: { id: "a", is_anonymous: true } as CallerUser }]) {
    const { deps, log } = setup(o.u);
    assert.equal((await handle(decline(o.h), deps)).status, 401);
    assert.equal(log.length, 0);
  }
});

test("decline: a body naming another user deletes only the verified caller", async () => {
  const { deps, db } = setup({ id: "u1" });
  await handle(decline(undefined, { action: "decline", user_id: "other" }), deps);
  assert.deepEqual(db.user_progress, [{ user_id: "other" }]);
});

test("unknown action is rejected and changes nothing", async () => {
  const { deps, writes, log } = setup({ id: "u1" });
  assert.equal((await handle(post({ authorization: "Bearer tok" }, JSON.stringify({ action: "wipe" })), deps)).status, 400);
  assert.equal(writes.length + log.length, 0);
});
