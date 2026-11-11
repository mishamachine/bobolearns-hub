/*
 * bb-analytics.js: first-party usage counts for Bobo Learns (guest events).
 *
 * What it does: gives each browser a random ID (a UUID kept in this browser's local storage), a guest name made
 * from that ID, and sends a few allow-listed events to our own server. It never sends an email, a name, free text,
 * a location or an account ID, and the guest ID is never joined to an account.
 *
 * It sends nothing unless BOBO_CONFIG.analytics.enabled is true (currently false), and nothing if the visitor has
 * turned it off here, or their browser sends Do Not Track or Global Privacy Control.
 *
 * No third-party tags. The SCHEMA below must equal supabase/functions/events/schema.js (a test checks it).
 */
(function () {
  "use strict";

  var SCHEMA = {
    apps: ["hub", "ruffspeak", "chess", "ridgeline", "bbsite"],
    platforms: ["web", "ios", "android"],
    surface: { re: "^[a-z][a-z0-9_-]{0,31}$" },
    events: {
      app_open: { props: { surface: { re: "^[a-z][a-z0-9_-]{0,31}$" }, auth_state: { enum: ["guest", "member"] } } },
      guest_continue: { props: { surface: { re: "^[a-z][a-z0-9_-]{0,31}$" } } },
      guest_popup_seen: { props: { surface: { re: "^[a-z][a-z0-9_-]{0,31}$" } } },
      signup_start: { props: { method: { enum: ["email", "google", "apple"] }, surface: { re: "^[a-z][a-z0-9_-]{0,31}$" } } },
      sign_up: { props: { auth_state: { enum: ["guest"] }, method: { enum: ["email", "google", "apple"] } }, required: { auth_state: "guest" } },
      sign_in: { props: { method: { enum: ["email", "google", "apple"] } } },
      guest_progress_moved: { props: {} },
      site_open: { props: { slug: { re: "^[a-z0-9-]{1,32}$" } }, apps: ["hub"] }
    }
  };

  var KEY_ID = "bb.anon.v1";
  var KEY_OFF = "bb.analytics.off";
  var KEY_SESSION = "bb.session.v1";
  var KEY_SOURCE = "bb.source.v1";
  var cfg = (window.BOBO_CONFIG && window.BOBO_CONFIG.analytics) || {};

  function store(kind) {
    try { return window[kind]; } catch (e) { return null; }
  }
  function get(kind, k) { try { var s = store(kind); return s ? s.getItem(k) : null; } catch (e) { return null; } }
  function set(kind, k, v) { try { var s = store(kind); if (s) { s.setItem(k, v); } } catch (e) { /* storage blocked */ } }
  function del(kind, k) { try { var s = store(kind); if (s) { s.removeItem(k); } } catch (e) { /* ignore */ } }

  function uuid4() {
    var c = window.crypto;
    if (c && c.randomUUID) { return c.randomUUID(); }
    var b = new Uint8Array(16);
    c.getRandomValues(b);
    b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
    var h = Array.prototype.map.call(b, function (x) { return ("0" + x.toString(16)).slice(-2); }).join("");
    return h.slice(0, 8) + "-" + h.slice(8, 12) + "-" + h.slice(12, 16) + "-" + h.slice(16, 20) + "-" + h.slice(20);
  }

  // Guest name from the ID: adjective + animal + 4 digits. The same ID always gives the same name; the name means nothing outside our tools.
  var ADJ = ["Amber", "Brave", "Brisk", "Calm", "Clever", "Cosmic", "Crisp", "Dapper", "Eager", "Fuzzy", "Gentle", "Golden", "Happy", "Jolly", "Keen", "Lucky", "Mellow", "Nimble", "Plucky", "Quiet", "Rosy", "Sunny", "Swift", "Teal"];
  var ANIMAL = ["Badger", "Beaver", "Corgi", "Dolphin", "Falcon", "Ferret", "Fox", "Gecko", "Heron", "Koala", "Lemur", "Llama", "Lynx", "Otter", "Panda", "Puffin", "Quokka", "Raccoon", "Robin", "Seal", "Tiger", "Turtle", "Walrus", "Yak"];
  function fnv1a(str) {
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h >>> 0;
  }
  function guestName(id) {
    var h = fnv1a(String(id));
    var h2 = fnv1a(String(id) + "#2");
    return "Guest " + ADJ[h % ADJ.length] + "-" + ANIMAL[h2 % ANIMAL.length] + "-" + ("000" + (fnv1a(String(id) + "#3") % 10000)).slice(-4);
  }

  function optedOut() {
    var nav = window.navigator || {};
    return get("localStorage", KEY_OFF) === "1" || nav.doNotTrack === "1" || window.doNotTrack === "1" || nav.globalPrivacyControl === true;
  }
  function active() { return cfg.enabled === true && !optedOut(); }

  var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  function anonId(create) {
    var id = get("localStorage", KEY_ID);
    if (id && UUID.test(id)) { return id; }
    if (!create) { return null; }
    id = uuid4();
    set("localStorage", KEY_ID, id);
    return id;
  }
  function sessionId() {
    var id = get("sessionStorage", KEY_SESSION);
    if (id && UUID.test(id)) { return id; }
    id = uuid4();
    set("sessionStorage", KEY_SESSION, id);
    return id;
  }

  // Where the visit came from, kept for the tab's session: utm tags (lowercase codes only) and the referrer's domain only.
  var TAG = /^[a-z0-9_-]{1,40}$/;
  function source() {
    var raw = get("sessionStorage", KEY_SOURCE);
    if (raw) { try { return JSON.parse(raw); } catch (e) { /* rebuild */ } }
    var out = {};
    try {
      var q = new URLSearchParams(location.search);
      ["utm_source", "utm_medium", "utm_campaign"].forEach(function (k) {
        var v = (q.get(k) || "").toLowerCase();
        if (TAG.test(v)) { out[k] = v; }
      });
      if (document.referrer) {
        var host = new URL(document.referrer).hostname.toLowerCase();
        var own = (window.BOBO_CONFIG && window.BOBO_CONFIG.rootHost) || "bobolearns.com";
        if (host && host !== own && !host.endsWith("." + own) && /^[a-z0-9.-]{1,80}$/.test(host)) { out.referrer_domain = host; }
      }
    } catch (e) { /* no source */ }
    set("sessionStorage", KEY_SOURCE, JSON.stringify(out));
    return out;
  }

  // Schema maps are read with hasOwn so "constructor", "__proto__" or "toString" never reach Object.prototype.
  function own(obj, key) { return typeof key === "string" && Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined; }

  function propOk(spec, v) {
    if (!spec) { return false; }
    if (spec.enum) { return spec.enum.indexOf(v) !== -1; }
    if (spec.re) { return typeof v === "string" && new RegExp(spec.re).test(v); }
    return false;
  }
  // Keeps an event only if every prop is on its allow-list with an allowed value. Anything else drops the whole event.
  function cleanProps(event, props) {
    var def = own(SCHEMA.events, event);
    if (!def || (def.apps && def.apps.indexOf(cfg.app) === -1)) { return null; }
    props = props || {};
    var clean = {};
    for (var k in props) {
      if (!Object.prototype.hasOwnProperty.call(props, k)) { continue; }
      if (!propOk(own(def.props, k), props[k])) { return null; }
      clean[k] = props[k];
    }
    for (var r in (def.required || {})) { if (clean[r] !== def.required[r]) { return null; } }
    return clean;
  }

  // "member" only means a sign-in session exists in this browser; we look for the cookie's name, never its value.
  function authState() {
    return /(?:^|;\s*)sb-[a-z0-9]+-auth-token(?:\.\d+)?=/.test(document.cookie || "") ? "member" : "guest";
  }

  function send(payload) {
    var body = JSON.stringify(payload);
    try {
      if (navigator.sendBeacon && navigator.sendBeacon(cfg.endpoint, new Blob([body], { type: "text/plain" }))) { return; }
    } catch (e) { /* fall through */ }
    try { fetch(cfg.endpoint, { method: "POST", body: body, headers: { "Content-Type": "text/plain" }, keepalive: true, credentials: "omit" }).catch(function () {}); } catch (e) { /* ignore */ }
  }

  function track(event, props) {
    if (!active() || !cfg.endpoint || SCHEMA.apps.indexOf(cfg.app) === -1) { return false; }
    var clean = cleanProps(event, props);
    if (!clean) { return false; }
    send({
      app: cfg.app, anon_id: anonId(true), session_id: sessionId(), platform: "web", app_version: cfg.version || undefined,
      source: source(), events: [{ event: event, props: clean }]
    });
    return true;
  }

  function surface() {
    var p = location.pathname.replace(/\/index\.html$/, "");
    var map = { "/": "home", "": "home", "/login/": "login", "/dashboard/": "dashboard", "/privacy/": "privacy", "/terms/": "terms" };
    return map[p] || "other";
  }

  function reset() { del("localStorage", KEY_ID); del("sessionStorage", KEY_SESSION); del("sessionStorage", KEY_SOURCE); }
  function setOff(off) { if (off) { set("localStorage", KEY_OFF, "1"); reset(); } else { del("localStorage", KEY_OFF); } }

  window.bbAnalytics = {
    SCHEMA: SCHEMA, track: track, cleanProps: cleanProps, guestName: guestName, anonId: anonId, authState: authState,
    reset: reset, setOff: setOff, isActive: active, optedOut: optedOut
  };

  // Privacy page controls (work whether or not counts are on): show this device's guest name, turn counts off, reset the ID.
  function privacyPage() {
    var nameEl = document.getElementById("anaGuestName");
    var offBox = document.getElementById("anaOff");
    var resetBtn = document.getElementById("anaReset");
    function paint() {
      var id = anonId(false);
      if (nameEl) { nameEl.textContent = id ? guestName(id) : "none yet"; }
      if (offBox) { offBox.checked = optedOut(); }
    }
    if (offBox) { offBox.addEventListener("change", function () { setOff(offBox.checked); paint(); }); }
    if (resetBtn) { resetBtn.addEventListener("click", function () { reset(); paint(); }); }
    paint();
  }

  document.addEventListener("click", function (e) {
    var a = e.target && e.target.closest ? e.target.closest("[data-track-site]") : null;
    if (a) { track("site_open", { slug: a.getAttribute("data-track-site") }); }
  });

  if (cfg.app === "hub") { track("app_open", { surface: surface(), auth_state: authState() }); }
  privacyPage();
})();
