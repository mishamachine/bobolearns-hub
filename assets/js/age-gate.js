/*
 * age-gate.js — one-time age confirmation for signed-in accounts.
 *
 * Statement (self-declared, no birthdate, no location check):
 *   "I'm at least 13 years old, and at least 16 if I live in the EU or UK."
 * A "Yes" calls the confirm-age Edge Function, which records the flag in the user's app_metadata on the
 * server (the browser cannot write app_metadata). "No" signs the user out. Requires bobo-auth.js.
 * Keep AGE_RULE_VERSION in step with the Edge Function; changing it asks everyone again.
 */
(function (root) {
  "use strict";

  var AGE_RULE_VERSION = "age-v1";
  var STATEMENT = "I'm at least 13 years old, and at least 16 if I live in the EU or UK.";
  var REFUSAL = "Sorry, you need to be at least 13 (16 in the EU or UK) to have an account. You can still use the free lessons without signing in.";
  var SAVE_ERROR = "We couldn't save that. Check your connection and try again.";

  function needsConfirm(user) {
    var m = user && user.app_metadata;
    return !(m && m.age_confirmed_at && m.age_rule_version === AGE_RULE_VERSION);
  }

  // Calls the server function, then refreshes the session so the new app_metadata reaches the browser.
  function confirmOnServer(client) {
    return client.functions.invoke("confirm-age", { method: "POST" }).then(function (res) {
      if (res.error) { throw res.error; }
      return client.auth.refreshSession();
    }).then(function (res) {
      if (res.error) { throw res.error; }
      if (needsConfirm(res.data && res.data.user)) { throw new Error("flag not visible after refresh"); }
      return true;
    });
  }

  function refuse(client) {
    return client.auth.signOut();
  }

  function el(tag, attrs, text) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) { n.setAttribute(k, attrs[k]); });
    if (text) { n.textContent = text; }
    return n;
  }

  // Shows the prompt. Resolves true once confirmed, false after a refusal (user is signed out).
  function run(client, user) {
    if (!needsConfirm(user)) { return Promise.resolve(true); }
    return new Promise(function (resolve) {
      var overlay = el("div", { "class": "age-overlay" });
      var box = el("div", { "class": "card age-card", role: "dialog", "aria-modal": "true", "aria-labelledby": "ageTitle", "aria-describedby": "ageText" });
      box.appendChild(el("h2", { id: "ageTitle" }, "One quick thing"));
      var text = el("p", { id: "ageText", "class": "age-statement" }, STATEMENT);
      var note = el("p", { "class": "msg err", role: "status", "aria-live": "polite", hidden: "" });
      var yes = el("button", { "class": "btn btn-red btn-block", type: "button" }, "Yes, that's right");
      var no = el("button", { "class": "btn btn-ghost btn-block", type: "button" }, "No");
      [text, note, yes, no].forEach(function (n) { box.appendChild(n); });
      overlay.appendChild(box);
      document.body.appendChild(overlay);
      yes.focus();

      box.addEventListener("keydown", function (e) {
        if (e.key !== "Tab") { return; }
        var items = [yes, no].filter(function (b) { return !b.hidden && !b.disabled; });
        if (!items.length) { return; }
        var first = items[0], last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      });

      function busy(on) { yes.disabled = on; no.disabled = on; }

      yes.addEventListener("click", function () {
        busy(true);
        note.hidden = true;
        confirmOnServer(client).then(function () {
          overlay.remove();
          resolve(true);
        }).catch(function () {
          busy(false);
          note.textContent = SAVE_ERROR;
          note.hidden = false;
        });
      });

      no.addEventListener("click", function () {
        busy(true);
        refuse(client).catch(function () { /* local session is cleared even if the call fails */ }).then(function () {
          text.textContent = REFUSAL;
          note.hidden = true;
          yes.hidden = true;
          no.hidden = true;
          var ok = el("button", { "class": "btn btn-red btn-block", type: "button" }, "OK");
          box.appendChild(ok);
          ok.focus();
          ok.addEventListener("click", function () { overlay.remove(); resolve(false); });
        });
      });
    });
  }

  var api = { AGE_RULE_VERSION: AGE_RULE_VERSION, STATEMENT: STATEMENT, REFUSAL: REFUSAL, needsConfirm: needsConfirm, confirmOnServer: confirmOnServer, refuse: refuse, run: run };
  root.boboAgeGate = api;
  if (typeof module !== "undefined" && module.exports) { module.exports = api; }
})(typeof window !== "undefined" ? window : this);
