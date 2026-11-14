// Add to Home Screen for the Bobo Learns hub.
// No analytics, no network calls. State lives in localStorage only.
(function () {
  "use strict";

  // ===== COPY (edit strings here only; the PM may switch the title) =====
  var COPY = {
    title: "Add Bobo Learns to your home screen",
    benefit: "Opens like an app, without the browser bars.",
    iosHowTo: "Tap Share, then Add to Home Screen.",
    add: "Add",
    gotIt: "Got it",
    notNow: "Not now",
    closeLabel: "Close",
    footerLink: "Add to home screen"
  };
  // ===== END COPY =====

  var KEY = "bobo_install_v1";
  var SHEET_GAP_MS = 14 * 24 * 60 * 60 * 1000; // pop-ups at least 14 days apart
  var MAX_DISMISSALS = 2;                      // then never again
  var SHEET_DELAY_MS = 6000;

  // ---- Detection (ported from Ridgeline src/lib/pwa.ts; in-app check added here) ----
  var isStandalone = function () {
    return (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) || navigator.standalone === true;
  };
  var isIOS = function () { return /iPad|iPhone|iPod/.test(navigator.userAgent); };
  var isInAppBrowser = function () { return /FBAN|FBAV|FB_IAB|Instagram|Line\/|Twitter|MicroMessenger|Snapchat|TikTok|musical_ly/i.test(navigator.userAgent); };
  var isPhone = function () {
    return /Android.+Mobile|iPhone|iPod/.test(navigator.userAgent) ||
      (window.matchMedia && window.matchMedia("(pointer: coarse) and (max-width: 820px)").matches);
  };

  // ---- State ----
  function load() {
    try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { return {}; }
  }
  function save(s) {
    try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (e) { /* storage blocked: fail quiet */ }
  }

  // ---- Service worker (shell only; see /sw.js) ----
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("/sw.js").catch(function () { /* not fatal */ });
    });
  }

  if (isStandalone()) { return; } // inside the installed app: no prompts of any kind

  var deferred = null;
  var path = location.pathname;
  var inLesson = /\/lesson/i.test(path);
  var onLogin = path.indexOf("/login") === 0;

  function installable() {
    if (isStandalone() || isInAppBrowser()) { return false; }
    return !!deferred || isIOS();
  }

  var openUi = null;
  function closeUi() { if (openUi) { openUi.remove(); openUi = null; } }

  // Runs the real install flow, or shows the iOS how-to. Returns "native", "howto" or "none".
  function doInstall(howtoTarget) {
    if (deferred) {
      var d = deferred;
      deferred = null;
      d.prompt();
      d.userChoice.then(function (r) {
        if (r && r.outcome === "accepted") { var s = load(); s.installed = true; save(s); }
        refreshFooter();
      }).catch(function () {});
      return "native";
    }
    if (isIOS()) {
      howtoTarget.textContent = COPY.iosHowTo;
      return "howto";
    }
    return "none";
  }

  // ---- UI builder: card (inline) and sheet (bottom) share one shape ----
  function build(kind, onDismiss) {
    var box = document.createElement("div");
    box.className = "install-" + kind;
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-label", COPY.title);

    var close = document.createElement("button");
    close.type = "button";
    close.className = "install-x";
    close.setAttribute("aria-label", COPY.closeLabel);
    close.textContent = "×";

    var h = document.createElement("strong");
    h.className = "install-title";
    h.textContent = COPY.title;

    var p = document.createElement("p");
    p.className = "install-text";
    p.textContent = COPY.benefit;

    var row = document.createElement("div");
    row.className = "install-row";
    var go = document.createElement("button");
    go.type = "button";
    go.className = "btn btn-red btn-sm";
    go.textContent = COPY.add;
    var no = document.createElement("button");
    no.type = "button";
    no.className = "btn btn-ghost btn-sm";
    no.textContent = COPY.notNow;
    row.appendChild(go);
    row.appendChild(no);

    box.appendChild(close);
    box.appendChild(h);
    box.appendChild(p);
    box.appendChild(row);

    function dismiss() { box.remove(); if (openUi === box) { openUi = null; } onDismiss(); }
    close.addEventListener("click", dismiss);
    var steps = false;
    no.addEventListener("click", function () { if (steps) { box.remove(); if (openUi === box) { openUi = null; } } else { dismiss(); } });
    go.addEventListener("click", function () {
      var r = doInstall(p);
      if (r === "howto") {
        // iOS step sheet: "Got it" just closes it and is not a dismissal
        row.removeChild(go);
        no.textContent = COPY.gotIt;
        steps = true;
      }
      else { box.remove(); if (openUi === box) { openUi = null; } }
    });
    box.addEventListener("keydown", function (e) { if (e.key === "Escape") { dismiss(); } });
    return box;
  }

  function showCard() {
    var main = document.getElementById("main");
    if (!main) { return; }
    var wrap = document.createElement("div");
    wrap.className = "wrap";
    var card = build("card", function () { wrap.remove(); });
    wrap.appendChild(card);
    main.insertBefore(wrap, main.firstChild);
  }

  function showSheet() {
    closeUi();
    openUi = build("sheet", function () {
      var s = load();
      s.dismissals = (s.dismissals || 0) + 1;
      save(s);
    });
    document.body.appendChild(openUi);
  }

  // ---- Footer link ----
  var footerBtn = null;
  function refreshFooter() {
    if (footerBtn) { footerBtn.hidden = !installable(); }
  }
  function addFooterLink() {
    var nav = document.querySelector(".footer-links");
    if (!nav) { return; }
    footerBtn = document.createElement("button");
    footerBtn.type = "button";
    footerBtn.className = "install-link";
    footerBtn.textContent = COPY.footerLink;
    footerBtn.hidden = true;
    footerBtn.addEventListener("click", function () {
      var holder = document.createElement("div");
      closeUi();
      if (deferred) { doInstall(holder); return; }
      // iOS: show the how-to in a sheet that does not count as a dismissal
      openUi = build("sheet", function () {});
      openUi.querySelector(".install-text").textContent = COPY.iosHowTo;
      var go = openUi.querySelector(".btn-red");
      go.parentNode.removeChild(go);
      openUi.querySelector(".btn-ghost").textContent = COPY.gotIt;
      document.body.appendChild(openUi);
    });
    nav.insertBefore(footerBtn, nav.firstChild);
    refreshFooter();
  }

  // ---- Wiring ----
  window.addEventListener("beforeinstallprompt", function (e) {
    e.preventDefault();
    deferred = e;
    refreshFooter();
    maybeSheet();
  });
  window.addEventListener("appinstalled", function () {
    var s = load();
    s.installed = true;
    save(s);
    deferred = null;
    closeUi();
    refreshFooter();
  });

  var sheetTimer = null;
  function shownThisVisit() { try { return sessionStorage.getItem(KEY) === "1"; } catch (e) { return false; } }
  function maybeSheet() {
    if (sheetTimer || shownThisVisit() || onLogin || inLesson || !isPhone() || !installable()) { return; }
    var s = load();
    if (s.installed || (s.dismissals || 0) >= MAX_DISMISSALS) { return; }
    if (s.lastSheet && Date.now() - s.lastSheet < SHEET_GAP_MS) { return; }
    sheetTimer = setTimeout(function () {
      if (isStandalone() || !installable() || openUi) { return; }
      var t = load();
      t.lastSheet = Date.now();
      save(t);
      try { sessionStorage.setItem(KEY, "1"); } catch (e) {}
      showSheet();
    }, SHEET_DELAY_MS);
  }

  function init() {
    addFooterLink();
    var s = load();
    // One-time onboarding card on the first phone visit, home page only. Its "Not now" does not count as a pop-up dismissal.
    if (!s.cardShown && path === "/" && isPhone() && !isInAppBrowser() && !s.installed && (isIOS() || "onbeforeinstallprompt" in window)) {
      s.cardShown = true;
      s.lastSheet = Date.now(); // the pop-up waits 14 days after the card
      save(s);
      try { sessionStorage.setItem(KEY, "1"); } catch (e) {}
      showCard();
      return;
    }
    maybeSheet();
  }
  if (document.readyState === "loading") { document.addEventListener("DOMContentLoaded", init); } else { init(); }
})();
