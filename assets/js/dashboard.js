// Dashboard: cross-site stats for the signed-in user.
// Reads the shared Supabase tables (daily_activity, user_settings, user_progress, site_events)
// and the per-site stat definitions in /sites.json. Row Level Security keeps data private.
(function () {
  "use strict";

  var A = window.boboAuth;
  var sb = A.client;
  var esc = window.boboEsc;
  var $ = function (id) { return document.getElementById(id); };
  var GOALS = [5, 10, 15, 20, 30];

  function pad(n) { return n < 10 ? "0" + n : "" + n; }
  function ymd(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  function daysAgo(n) { var d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - n); return d; }

  // Streak = consecutive days with any study time, counting back from today (or yesterday).
  function streaks(byDate) {
    var current = 0;
    var start = byDate[ymd(daysAgo(0))] > 0 ? 0 : (byDate[ymd(daysAgo(1))] > 0 ? 1 : -1);
    if (start >= 0) {
      for (var i = start; byDate[ymd(daysAgo(i))] > 0; i++) { current++; }
    }
    var dates = Object.keys(byDate).filter(function (k) { return byDate[k] > 0; }).sort();
    var best = 0, run = 0, prev = null;
    dates.forEach(function (k) {
      var d = new Date(k + "T12:00:00");
      run = prev && Math.round((d - prev) / 864e5) === 1 ? run + 1 : 1;
      best = Math.max(best, run);
      prev = d;
    });
    return { current: current, best: best };
  }

  function relTime(date) {
    var days = Math.floor((Date.now() - date.getTime()) / 864e5);
    if (days <= 0) { return "today"; }
    if (days === 1) { return "yesterday"; }
    if (days < 30) { return days + " days ago"; }
    return date.toLocaleDateString();
  }

  function fmt(v, spec) {
    if (v === null || v === undefined) { return "—"; }
    var n = spec.agg === "avg" ? Math.round(v) : v;
    return n + (spec.suffix || "");
  }

  function applyWhere(q, where) {
    Object.keys(where || {}).forEach(function (k) { q = q.eq(k, where[k]); });
    return q;
  }

  // Runs one declarative stat from sites.json. Returns null on any error (e.g. table not created yet).
  function runStat(spec, uid) {
    if (spec.agg === "count") {
      return applyWhere(sb.from(spec.table).select("*", { count: "exact", head: true }).eq("user_id", uid), spec.where)
        .then(function (r) { return r.error ? null : (r.count || 0); }, function () { return null; });
    }
    return applyWhere(sb.from(spec.table).select(spec.column).eq("user_id", uid), spec.where)
      .then(function (r) {
        if (r.error) { return null; }
        var vals = r.data.map(function (row) { return row[spec.column]; }).filter(function (v) { return v !== null && v !== undefined; });
        if (spec.agg === "distinct") { return new Set(vals).size; }
        if (!vals.length) { return null; }
        var sum = vals.reduce(function (a, b) { return a + Number(b); }, 0);
        return spec.agg === "avg" ? sum / vals.length : sum;
      }, function () { return null; });
  }

  function runLastActive(spec, uid) {
    if (!spec) { return Promise.resolve(null); }
    return applyWhere(sb.from(spec.table).select(spec.column).eq("user_id", uid), spec.where)
      .order(spec.column, { ascending: false }).limit(1)
      .then(function (r) {
        return !r.error && r.data && r.data.length ? new Date(r.data[0][spec.column]) : null;
      }, function () { return null; });
  }

  function loadSite(site, uid) {
    if (site.status !== "live") { return Promise.resolve({ site: site, stats: [], last: null }); }
    return Promise.all([
      Promise.all((site.stats || []).map(function (s) { return runStat(s, uid); })),
      runLastActive(site.lastActive, uid)
    ]).then(function (res) { return { site: site, stats: res[0], last: res[1] }; });
  }

  function siteCard(item) {
    var s = item.site, live = s.status === "live", used = !!item.last;
    var stats = used ? '<div class="pill-stats">' + (s.stats || []).map(function (spec, i) {
      return '<div class="pill-stat"><b>' + esc(fmt(item.stats[i], spec)) + "</b><span>" + esc(spec.label) + "</span></div>";
    }).join("") + "</div>" : "";
    var line = !live ? "Coming soon" : used ? "Last active " + relTime(item.last) : "Not started yet";
    var inner =
      '<span class="accent" style="background:' + esc(s.accent || "#111") + '"></span>' +
      '<div class="ico" aria-hidden="true" style="margin-top:8px">' + esc(s.emoji || "📚") + "</div>" +
      "<h3>" + esc(s.name) + "</h3>" +
      '<p class="muted" style="font-size:.85rem;font-weight:700;text-transform:uppercase">' + esc(line) + "</p>" +
      stats +
      (live ? '<span class="go">' + (used ? "Jump back in →" : "Start here →") + "</span>" : "<p>" + esc(s.tagline) + "</p>");
    return live
      ? '<a class="card site" href="' + esc(s.url) + '">' + inner + "</a>"
      : '<div class="card site is-soon">' + inner + "</div>";
  }

  function render(ctx) {
    var uid = ctx.user.id;
    var meta = ctx.user.user_metadata || {};
    var name = meta.full_name || meta.name || (ctx.user.email || "").split("@")[0] || "friend";
    $("hello").textContent = "Hey, " + name.split(" ")[0] + ".";

    var byDate = {};
    ctx.activity.forEach(function (r) { byDate[r.activity_date] = r.seconds_studied; });
    var todaySec = byDate[ymd(new Date())] || 0;
    var goal = ctx.goal;
    var pct = Math.min(100, Math.round((todaySec / (goal * 60)) * 100));
    var mins = Math.floor(todaySec / 60);

    $("ring").style.setProperty("--p", pct);
    $("ringNum").textContent = mins;
    $("goalLine").textContent = pct >= 100 ? "Daily goal hit. Nice work." : (goal - mins) + " min to reach your " + goal + " min goal";

    var st = streaks(byDate);
    $("streak").textContent = st.current;
    $("streakUnit").textContent = st.current === 1 ? "day" : "days";
    $("streakNote").textContent = st.current === 0
      ? "Study a little today to start a streak."
      : (byDate[ymd(new Date())] > 0 ? "Kept alive today." : "Study today to keep it alive.") + " Best: " + st.best + ".";

    var weekMax = 1, days = [];
    for (var i = 6; i >= 0; i--) {
      var d = daysAgo(i), sec = byDate[ymd(d)] || 0;
      weekMax = Math.max(weekMax, sec);
      days.push({ label: d.toLocaleDateString(undefined, { weekday: "narrow" }), sec: sec, today: i === 0 });
    }
    var weekMin = Math.round(days.reduce(function (a, d) { return a + d.sec; }, 0) / 60);
    $("weekTotal").textContent = weekMin + " min this week";
    $("bars").innerHTML = days.map(function (d) {
      var h = d.sec ? Math.max(6, Math.round((d.sec / weekMax) * 100)) : 4;
      return '<div class="bar' + (d.today ? " today" : "") + (d.sec ? "" : " zero") + '" title="' + Math.round(d.sec / 60) + ' min">' +
        '<i style="height:' + h + '%"></i><span>' + esc(d.label) + "</span></div>";
    }).join("");

    // Most recently used site first, then live-but-unused, then coming soon.
    var items = ctx.sites.slice().sort(function (a, b) {
      function rank(x) { return x.site.status !== "live" ? 2 : x.last ? 0 : 1; }
      if (rank(a) !== rank(b)) { return rank(a) - rank(b); }
      return (b.last || 0) - (a.last || 0);
    });
    var top = items[0];
    var cont = $("continue");
    if (top && top.last) {
      cont.hidden = false;
      cont.innerHTML = '<div><p class="eyebrow">Pick up where you left off</p><h2>' + esc(top.site.name) +
        '</h2><p style="margin:0">Last active ' + esc(relTime(top.last)) + '.</p></div>' +
        '<a class="btn btn-red" href="' + esc(top.site.url) + '">Continue →</a>';
    } else {
      var first = items.filter(function (x) { return x.site.status === "live"; })[0];
      cont.hidden = !first;
      if (first) {
        cont.innerHTML = '<div><p class="eyebrow">Welcome</p><h2>Start with ' + esc(first.site.name) +
          '</h2><p style="margin:0">Your stats will show up here as soon as you finish a lesson.</p></div>' +
          '<a class="btn btn-red" href="' + esc(first.site.url) + '">Get started →</a>';
      }
    }

    $("sitesGrid").innerHTML = items.map(siteCard).join("");
    $("email").textContent = ctx.user.email || "";
    var sel = $("goalSel");
    sel.innerHTML = GOALS.map(function (g) { return '<option value="' + g + '"' + (g === goal ? " selected" : "") + ">" + g + " minutes</option>"; }).join("");
    sel.onchange = function () {
      var val = parseInt(sel.value, 10);
      $("goalMsg").textContent = "Saving…";
      sb.from("user_settings").upsert({ user_id: uid, daily_goal_minutes: val, updated_at: new Date().toISOString() })
        .then(function (r) {
          if (r.error) { $("goalMsg").textContent = "Couldn't save that. Try again."; return; }
          $("goalMsg").textContent = "Saved. Your goal applies from today.";
          ctx.goal = val;
          render(ctx);
        });
    };
  }

  A.getSession().then(function (session) {
    if (!session) {
      location.replace("/login/?next=" + encodeURIComponent("/dashboard/"));
      return;
    }
    var user = session.user;
    var since = ymd(daysAgo(400));

    Promise.all([
      sb.from("daily_activity").select("activity_date,seconds_studied").eq("user_id", user.id)
        .gte("activity_date", since).order("activity_date", { ascending: false }),
      sb.from("user_settings").select("daily_goal_minutes").eq("user_id", user.id).maybeSingle(),
      fetch("/sites.json", { cache: "no-cache" }).then(function (r) { return r.json(); })
    ]).then(function (res) {
      var goal = res[1].data && res[1].data.daily_goal_minutes ? res[1].data.daily_goal_minutes : 10;
      return Promise.all(res[2].sites.map(function (s) { return loadSite(s, user.id); })).then(function (sites) {
        var ctx = { user: user, activity: res[0].data || [], goal: goal, sites: sites };
        $("loading").hidden = true;
        $("app").hidden = false;
        render(ctx);
      });
    }).catch(function () {
      $("loading").innerHTML = '<div class="card">We couldn\'t load your stats. Refresh to try again.</div>';
    });

    $("signout").addEventListener("click", function () {
      A.signOut().then(function () { location.assign("/"); });
    });
  });
})();
