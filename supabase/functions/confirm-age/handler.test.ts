// Run: node --test supabase/functions/confirm-age/handler.test.ts  (Node 22.6+ strips the types)
import test from "node:test";
import assert from "node:assert/strict";
import { handle, AGE_RULE_VERSION } from "./handler.ts";
import type { CallerUser } from "./handler.ts";

const NOW = new Date("2026-11-07T12:00:00.000Z");

function setup(user: CallerUser | null, opts: { writeError?: string; throwOnGet?: boolean } = {}) {
  const writes: Array<{ id: string; metadata: Record<string, unknown> }> = [];
  const deps = {
    now: () => NOW,
    getUser: async (_jwt: string) => {
      if (opts.throwOnGet) throw new Error("bad jwt");
      return user;
    },
    setAppMetadata: async (id: string, metadata: Record<string, unknown>) => {
      writes.push({ id, metadata });
      return { error: opts.writeError ?? null };
    },
  };
  return { deps, writes };
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
