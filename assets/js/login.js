// Login / sign-up / password reset. One account works across every BoboLearns site.
(function () {
  "use strict";

  var A = window.boboAuth;
  var sb = A.client;
  var params = new URLSearchParams(location.search);
  var next = A.safeNext(params.get("next"));
  var dest = A.absolute(next);

  var $ = function (id) { return document.getElementById(id); };

  // Hide sign-in providers that aren't switched on yet (see BOBO_CONFIG.providers).
  document.querySelectorAll("[data-provider]").forEach(function (b) {
    if (!window.BOBO_CONFIG.providers[b.getAttribute("data-provider")]) { b.hidden = true; }
  });
  var mode = "signin";

  function msg(text, kind) {
    var el = $("msg");
    el.hidden = !text;
    el.textContent = text || "";
    el.className = "msg" + (kind ? " " + kind : "");
  }

  function setMode(m) {
    mode = m;
    $("tabIn").setAttribute("aria-selected", m === "signin");
    $("tabUp").setAttribute("aria-selected", m === "signup");
    $("submit").textContent = m === "signin" ? "Log in" : "Create account";
    $("password").autocomplete = m === "signin" ? "current-password" : "new-password";
    $("forgotRow").hidden = m !== "signin";
    $("terms").hidden = m !== "signup";
    msg("");
  }

  function busy(on) {
    document.querySelectorAll("#authPanel button").forEach(function (b) { b.disabled = on; });
  }

  function friendly(err) {
    var m = (err && err.message) || "Something went wrong.";
    if (/invalid login credentials/i.test(m)) { return "That email and password don't match. Try again or reset your password."; }
    if (/already registered|already been registered/i.test(m)) { return "That email already has an account. Switch to Log in."; }
    if (/provider is not enabled|unsupported provider/i.test(m)) { return "That sign-in method isn't switched on yet. Use email for now."; }
    return m;
  }

  $("tabIn").addEventListener("click", function () { setMode("signin"); });
  $("tabUp").addEventListener("click", function () { setMode("signup"); });

  $("authForm").addEventListener("submit", function (e) {
    e.preventDefault();
    var email = $("email").value.trim();
    var password = $("password").value;
    if (!email || !password) { return msg("Enter your email and password.", "err"); }
    if (mode === "signup" && password.length < 8) { return msg("Use at least 8 characters for your password.", "err"); }
    busy(true);
    msg("");
    var req = mode === "signin"
      ? sb.auth.signInWithPassword({ email: email, password: password })
      : sb.auth.signUp({ email: email, password: password, options: { emailRedirectTo: dest } });
    req.then(function (res) {
      if (res.error) { throw res.error; }
      if (res.data && res.data.session) { location.assign(dest); return; }
      busy(false);
      msg("Almost there. We sent a confirmation link to " + email + ". Open it to finish signing up.", "ok");
    }).catch(function (err) { busy(false); msg(friendly(err), "err"); });
  });

  document.querySelectorAll("[data-provider]").forEach(function (b) {
    b.addEventListener("click", function () {
      busy(true);
      msg("");
      sb.auth.signInWithOAuth({ provider: b.getAttribute("data-provider"), options: { redirectTo: dest } })
        .then(function (res) { if (res.error) { throw res.error; } })
        .catch(function (err) { busy(false); msg(friendly(err), "err"); });
    });
  });

  $("forgot").addEventListener("click", function () {
    var email = $("email").value.trim();
    if (!email) { return msg("Type your email above first, then tap “Forgot password?”.", "err"); }
    busy(true);
    sb.auth.resetPasswordForEmail(email, { redirectTo: A.absolute("/login/") })
      .then(function (res) {
        busy(false);
        if (res.error) { throw res.error; }
        msg("If an account exists for " + email + ", a reset link is on its way.", "ok");
      }).catch(function (err) { busy(false); msg(friendly(err), "err"); });
  });

  // Password recovery: Supabase fires PASSWORD_RECOVERY after the emailed link is opened.
  sb.auth.onAuthStateChange(function (event) {
    if (event === "PASSWORD_RECOVERY") {
      $("authPanel").hidden = true;
      $("resetPanel").hidden = false;
    }
  });

  $("resetForm").addEventListener("submit", function (e) {
    e.preventDefault();
    var pw = $("newPassword").value;
    if (pw.length < 8) { return msg("Use at least 8 characters for your password.", "err"); }
    sb.auth.updateUser({ password: pw }).then(function (res) {
      if (res.error) { throw res.error; }
      location.assign(dest);
    }).catch(function (err) { msg(friendly(err), "err"); });
  });

  // Already signed in? Skip the form (unless we're mid-recovery).
  var recovering = params.has("code") || /type=recovery/.test(location.hash);
  A.getSession().then(function (session) {
    if (session && !recovering) { location.replace(dest); }
  });

  if (params.get("mode") === "signup") { setMode("signup"); }
  var err = params.get("error_description");
  if (err) { msg(err, "err"); }
})();
