/*
 * bobo-auth.js — shared BoboLearns login client.
 *
 * Drop this file (plus config.js and the supabase-js script) into ANY *.bobolearns.com site and
 * use `window.boboAuth.client` instead of creating your own Supabase client. The session is stored
 * in a cookie scoped to .bobolearns.com, so signing in on one site signs you in on all of them.
 *
 * Requires: window.supabase (supabase-js v2 UMD) and window.BOBO_CONFIG.
 */
(function () {
  "use strict";

  var cfg = window.BOBO_CONFIG;
  var STORAGE_KEY = "bobo-auth";
  var CHUNK = 3000; // stay well under the ~4KB per-cookie limit
  var onRoot = location.hostname === cfg.rootHost || location.hostname.endsWith("." + cfg.rootHost);

  function writeCookie(name, value, days) {
    var parts = [name + "=" + value, "path=/", "max-age=" + Math.round(days * 86400), "SameSite=Lax"];
    if (onRoot) { parts.push("Domain=" + cfg.cookieDomain, "Secure"); }
    document.cookie = parts.join("; ");
  }

  function readCookie(name) {
    var prefix = name + "=";
    var items = document.cookie ? document.cookie.split("; ") : [];
    for (var i = 0; i < items.length; i++) {
      if (items[i].indexOf(prefix) === 0) { return items[i].slice(prefix.length); }
    }
    return null;
  }

  // Cookie-backed storage adapter for supabase-js. Large values are split into chunks.
  var cookieStorage = {
    getItem: function (key) {
      var count = parseInt(readCookie(key + ".n"), 10);
      if (!count) { return null; }
      var out = "";
      for (var i = 0; i < count; i++) {
        var part = readCookie(key + "." + i);
        if (part === null) { return null; }
        out += part;
      }
      try { return decodeURIComponent(out); } catch (e) { return null; }
    },
    setItem: function (key, value) {
      var enc = encodeURIComponent(value);
      var prev = parseInt(readCookie(key + ".n"), 10) || 0;
      var chunks = Math.max(1, Math.ceil(enc.length / CHUNK));
      for (var i = 0; i < chunks; i++) {
        writeCookie(key + "." + i, enc.slice(i * CHUNK, (i + 1) * CHUNK), 400);
      }
      for (var j = chunks; j < prev; j++) { writeCookie(key + "." + j, "", 0); }
      writeCookie(key + ".n", String(chunks), 400);
    },
    removeItem: function (key) {
      var prev = parseInt(readCookie(key + ".n"), 10) || 0;
      for (var i = 0; i < prev; i++) { writeCookie(key + "." + i, "", 0); }
      writeCookie(key + ".n", "", 0);
    }
  };

  var client = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey, {
    auth: {
      storage: cookieStorage,
      storageKey: STORAGE_KEY,
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      flowType: "pkce"
    }
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
