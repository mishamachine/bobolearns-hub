// Homepage: render the sites grid from /sites.json.
(function () {
  "use strict";
  var esc = window.boboEsc;
  var grid = document.getElementById("sitesGrid");
  if (!grid) { return; }

  function card(s) {
    var live = s.status === "live";
    var tags = (s.tags || []).map(function (t) { return '<span class="tag">' + esc(t) + "</span>"; }).join("");
    var status = '<span class="tag ' + (live ? "live" : "soon") + '">' + (live ? "Live" : "Coming soon") + "</span>";
    var inner =
      '<span class="accent" style="background:' + esc(s.accent || "#111") + '"></span>' +
      '<div class="ico" aria-hidden="true" style="margin-top:8px">' + esc(s.emoji || "📚") + "</div>" +
      "<div>" + status + "</div>" +
      "<h3>" + esc(s.name) + "</h3>" +
      "<p>" + esc(s.tagline) + "</p>" +
      "<div>" + tags + "</div>" +
      (live ? '<span class="go">Open site →</span>' : "");
    return live
      ? '<a class="card site" href="' + esc(s.url) + '">' + inner + "</a>"
      : '<div class="card site is-soon">' + inner + "</div>";
  }

  fetch("/sites.json", { cache: "no-cache" })
    .then(function (r) { return r.json(); })
    .then(function (data) { grid.innerHTML = data.sites.map(card).join(""); })
    .catch(function () {
      grid.innerHTML = '<div class="card">Couldn\'t load the site list. Try refreshing.</div>';
    });
})();
