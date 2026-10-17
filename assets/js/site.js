// Small shared helpers: footer year, auth-aware nav button, HTML escaping.
(function () {
  "use strict";

  window.boboEsc = function (s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  };

  document.querySelectorAll("[data-year]").forEach(function (el) { el.textContent = new Date().getFullYear(); });
  document.querySelectorAll("[data-contact]").forEach(function (el) {
    var email = (window.BOBO_CONFIG && window.BOBO_CONFIG.contactEmail) || el.textContent;
    el.textContent = email;
    if (el.tagName === "A") { el.href = "mailto:" + email; }
  });

  var btn = document.getElementById("navAuth");
  if (btn && window.boboAuth) {
    window.boboAuth.getSession().then(function (session) {
      if (session) { btn.textContent = "Dashboard"; btn.href = "/dashboard/"; }
    }).catch(function () { /* stay on "Log in" */ });
  }
})();
