// Run: node --test tests/   (no browser needed; the Supabase client is a stub)
const test = require("node:test");
const assert = require("node:assert/strict");
const gate = require("../assets/js/age-gate.js");

const V = gate.AGE_RULE_VERSION;
const confirmed = { app_metadata: { age_confirmed_at: "2026-11-07T00:00:00.000Z", age_rule_version: V } };

test("statement and refusal copy match the spec", () => {
  assert.equal(gate.STATEMENT, "I'm at least 13 years old, and at least 16 if I live in the EU or UK.");
  assert.equal(gate.REFUSAL, "Sorry, you need to be at least 13 (16 in the EU or UK) to have an account. You can still use the free lessons without signing in.");
});

test("needsConfirm: new, old-version and partial accounts are asked; current ones are not", () => {
  assert.equal(gate.needsConfirm({ app_metadata: {} }), true);
  assert.equal(gate.needsConfirm({}), true);
  assert.equal(gate.needsConfirm(null), true);
  assert.equal(gate.needsConfirm({ app_metadata: { age_confirmed_at: "x", age_rule_version: "age-v0" } }), true);
  assert.equal(gate.needsConfirm({ app_metadata: { age_rule_version: V } }), true);
  assert.equal(gate.needsConfirm(confirmed), false);
});

test("user_metadata cannot satisfy the check (client-writable)", () => {
  assert.equal(gate.needsConfirm({ app_metadata: {}, user_metadata: { age_confirmed_at: "x", age_rule_version: V } }), true);
});

function client({ invokeError = null, refreshUser = confirmed, refreshError = null, counts = {} } = {}) {
  const calls = [];
  return {
    calls,
    from: (table) => ({ select: () => ({ eq: async () => (counts[table] === "err" ? { error: new Error("x") } : { count: counts[table] || 0, error: null }) }) }),
    functions: { invoke: async (name, opts) => { calls.push(["invoke", name, opts && opts.method, opts && opts.body && opts.body.action]); return { error: invokeError }; } },
    auth: {
      refreshSession: async () => { calls.push(["refresh"]); return { data: { user: refreshUser }, error: refreshError }; },
      signOut: async () => { calls.push(["signOut"]); return { error: null }; },
    },
  };
}

test("confirmOnServer: calls the function, then refreshes the session", async () => {
  const c = client();
  assert.equal(await gate.confirmOnServer(c), true);
  assert.deepEqual(c.calls, [["invoke", "confirm-age", "POST", undefined], ["refresh"]]);
});

test("confirmOnServer: function error means no refresh and a rejection", async () => {
  const c = client({ invokeError: new Error("401") });
  await assert.rejects(gate.confirmOnServer(c));
  assert.deepEqual(c.calls.map((x) => x[0]), ["invoke"]);
});

test("confirmOnServer: rejects if the flag is still missing after refresh", async () => {
  await assert.rejects(gate.confirmOnServer(client({ refreshUser: { app_metadata: {} } })));
});

test("run: an already-confirmed user is not prompted and nothing is called", async () => {
  const c = client();
  assert.equal(await gate.run(c, confirmed), true);
  assert.equal(c.calls.length, 0);
});

test("decline: asks the server to delete (never a client-side delete), then clears the local session", async () => {
  const c = client();
  c.auth.signOut = async (o) => { c.calls.push(["signOut", o && o.scope]); return { error: null }; };
  await gate.declineOnServer(c);
  assert.deepEqual(c.calls, [["invoke", "confirm-age", "POST", "decline"], ["signOut", "local"]]);
});

test("decline: a server failure rejects and the session is kept", async () => {
  const c = client({ invokeError: new Error("500") });
  await assert.rejects(gate.declineOnServer(c));
  assert.deepEqual(c.calls.map((x) => x[0]), ["invoke"]);
});

test("hasProgress: true if any study table has rows or a read fails; false for a new account", async () => {
  assert.equal(await gate.hasProgress(client(), "u1"), false);
  assert.equal(await gate.hasProgress(client({ counts: { daily_activity: 3 } }), "u1"), true);
  assert.equal(await gate.hasProgress(client({ counts: { saved_lessons: "err" } }), "u1"), true);
});

test("warning copy matches the ruling", () => {
  assert.equal(gate.DELETE_WARNING, "This will delete your account and all your progress. Continue?");
});
