/*
 * bobo-auth.js — shared BoboLearns login client.
 *
 * The hub's login client. It reads and writes the SAME shared session cookie as Lingo and Chess
 * (cookie scoped to .bobolearns.com, default Supabase storage key), so signing in on any BoboLearns
 * site signs you in on all of them. Static sites can reuse this file; React apps already have the
 * equivalent in src/lib/cookieStorage.ts.
 *
 * Requires: window.supabase (supabase-js v2 UMD) and window.BOBO_CONFIG.
 */
(function () {
  "use strict";

  var cfg = window.BOBO_CONFIG;
  var CHUNK = 3000; // encoded characters per cookie; browsers cap a cookie near 4 KB
  var MAX_AGE = 60 * 60 * 24 * 365;
  // Same rule as Lingo/Chess: shared cookies on *.bobolearns.com, localStorage anywhere else.
  var useCookies = /(^|\.)bobolearns\.com$/.test(location.hostname);

  function readCookies() {
    var map = {};
    (document.cookie ? document.cookie.split("; ") : []).forEach(function (part) {
      var i = part.indexOf("=");
      if (i > 0) { map[part.slice(0, i)] = part.slice(i + 1); }
    });
    return map;
  }

  function writeCookie(name, value, maxAge) {
    document.cookie = name + "=" + value + "; Domain=" + cfg.cookieDomain + "; Path=/; Max-Age=" + maxAge + "; SameSite=Lax; Secure";
  }

  function clear(key) {
    var cookies = readCookies();
    Object.keys(cookies).forEach(function (name) {
      if (name === key || name.indexOf(key + ".") === 0) { writeCookie(name, "", 0); }
    });
  }

  // IMPORTANT: this adapter and the default Supabase storage key must stay byte-for-byte compatible
  // with src/lib/cookieStorage.ts in the Lingo and Chess repos, or sessions will not be shared.
  var sessionStorageAdapter = {
    getItem: function (key) {
      if (!useCookies) { return window.localStorage.getItem(key); }
      var cookies = readCookies();
      var out = "";
      for (var i = 0; ; i++) {
        var chunk = cookies[key + "." + i];
        if (chunk === undefined) { break; }
        out += chunk;
      }
      if (!out) { return null; }
      try { return decodeURIComponent(out); } catch (e) { return null; }
    },
    setItem: function (key, value) {
      if (!useCookies) { window.localStorage.setItem(key, value); return; }
      clear(key);
      var encoded = encodeURIComponent(value);
      for (var i = 0, n = 0; i < encoded.length; i += CHUNK, n++) {
        writeCookie(key + "." + n, encoded.slice(i, i + CHUNK), MAX_AGE);
      }
    },
    removeItem: function (key) {
      if (!useCookies) { window.localStorage.removeItem(key); return; }
      clear(key);
    }
  };

  // Same options as Lingo: custom storage only (default storage key and default auth flow).
  var client = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey, {
    auth: { storage: sessionStorageAdapter }
  });

  // Only allow redirects to this hub or another *.bobolearns.com site (prevents open redirects).
  function safeNext(raw, fallback) {
    fallback = fallback || "/dashboard/";
    if (!raw) { return fallback; }
    if (raw.charAt(0) === "/" && raw.charAt(1) !== "/" && raw.indexOf("\\") === -1) { return raw; }
    try {
      var u = new URL(raw);
      var ok = u.protocol === "https:" && (u.hostname === cfg.rootHost || u.hostname.endsWith("." + cfg.rootHost));
      return ok ? u.href : fallback;
    } catch (e) { return fallback; }
  }

  function absolute(path) {
    try { return new URL(path, location.origin).href; } catch (e) { return location.origin + "/dashboard/"; }
  }

  window.boboAuth = {
    client: client,
    safeNext: safeNext,
    absolute: absolute,
    getSession: function () { return client.auth.getSession().then(function (r) { return r.data.session; }); },
    signOut: function () { return client.auth.signOut(); }
  };
})();
