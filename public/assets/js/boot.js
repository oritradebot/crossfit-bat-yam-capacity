/* ============================================================
   boot.js  —  the Supabase adapter that wraps the exported app
   WITHOUT modifying a single line of the app's own code.

   Flow:
     1. Require a logged-in session (else bounce to index.html).
     2. Load the shared program (admin-authored) + this user's saved
        results from Supabase, MERGE them, seed localStorage.
     3. Load the shared leaderboard into localStorage.
     4. Intercept localStorage.setItem so every change the app makes
        is pushed back to Supabase (debounced).
     5. ONLY THEN load dc-runtime.js so the app boots with data ready.
   ============================================================ */
(function () {
  "use strict";
  // Bumped on EVERY deploy, together with public/version.json. The pair powers
  // the self-update check below — installed PWAs kept running stale bundles
  // for days, and "close the app fully and reopen" proved unreliable advice.
  // Semantic versioning per Ori: 1.0.1 and counting.
  var BUILD = "1.6.0";
  var K = window.CFBY;
  var sb = window.supabase.createClient(window.SUPA_URL, window.SUPA_ANON_KEY);
  window.__sb = sb;

  // ---- helpers ---------------------------------------------------------
  function loadScript(src) {
    return new Promise(function (res, rej) {
      var s = document.createElement("script");
      s.src = src; s.onload = res; s.onerror = rej;
      document.head.appendChild(s);
    });
  }
  function lsGet(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } }
  function lsSetRaw(k, v) { localStorage.setItem(k, JSON.stringify(v)); }

  // NOTE: program/results merging is NOT done here any more. The app owns it:
  // normalizeWeeks() coerces any saved blob into its canonical shape, and
  // applyProgram() overlays the built-in program when the saved program version
  // is older than the app's. boot.js just seeds the raw blob and lets the app
  // reconcile it.

  // ---- Supabase reads --------------------------------------------------
  async function fetchSharedProgram() {
    try {
      var r = await sb.from("shared_program").select("weeks").eq("id", 1).maybeSingle();
      return (r.data && r.data.weeks) || null;
    } catch (e) { return null; }
  }
  // A failed query (offline / flaky signal / server hiccup) says NOTHING about
  // whether the row exists — every fetch below reports errors separately so a
  // network failure can never be mistaken for "fresh user, wipe the device".
  async function fetchMyState(uid) {
    try {
      var r = await sb.from("states").select("tracker,updated_at").eq("user_id", uid).maybeSingle();
      return { row: r.data || null, error: r.error || null };
    } catch (e) { return { row: null, error: e }; }
  }
  async function fetchBoard() {
    try {
      var r = await sb.from("board").select("user_id,name,results,weeks,metcons,pub").order("name");
      return { rows: r.data || [], error: r.error || null };
    } catch (e) { return { rows: [], error: e }; }
  }
  async function fetchProfile(uid) {
    try {
      var r = await sb.from("profiles").select("name,is_admin,welcome_seen,gender,birth_date,announcement_seen").eq("id", uid).maybeSingle();
      if (r.error) throw r.error;
      return r.data || { name: "", is_admin: false, welcome_seen: false, gender: null, birth_date: null, announcement_seen: null };
    } catch (e) {
      return { name: "", is_admin: false, welcome_seen: false, gender: null, birth_date: null, announcement_seen: null, _err: true };
    }
  }
  // The block announcement the admin published (or null). Fetched separately
  // from the program: it is read on EVERY boot, while the program row's weeks
  // blob is only pulled for fresh users.
  async function fetchAnnouncement() {
    try {
      var r = await sb.from("shared_program").select("announcement").eq("id", 1).maybeSingle();
      return (r.data && r.data.announcement) || null;
    } catch (e) { return null; }
  }
  // Every registered athlete — the leaderboard is built from this so a user
  // appears the moment their account exists, before they log any workout.
  async function fetchAllProfiles() {
    try {
      var r = await sb.from("profiles").select("id,name,is_admin,gender,birth_date");
      return r.data || [];
    } catch (e) { return []; }
  }

  // ---- program scaffold hygiene ----------------------------------------
  // The shared program must be a SCAFFOLD: plan text only, no personal data.
  // It used to be published straight from the admin's tracker, logs included —
  // so every fresh device booted with the admin's old results baked in (and the
  // admin himself kept "recovering" to that stale snapshot after a wipe).
  function stripDayLogs(d) {
    if (!d) return d;
    d.done = false; d.rest = false; d.rating = ""; d.summary = ""; d.pr = false;
    if (d.lift) delete d.lift.log;
    if (d.metcon)  { delete d.metcon.log;  d.metcon.rx = false;  d.metcon.scaled = false; }
    if (d.metcon2) { delete d.metcon2.log; d.metcon2.rx = false; d.metcon2.scaled = false; }
    if (Array.isArray(d.extras)) d.extras.forEach(function (x) { if (x) { x.result = ""; delete x.log; } });
    if (d.alt) stripDayLogs(d.alt);
    return d;
  }
  function stripLogs(weeks) {
    var w;
    try { w = JSON.parse(JSON.stringify(weeks || [])); } catch (e) { return []; }
    w.forEach(function (wk) { ((wk && wk.days) || []).forEach(stripDayLogs); });
    return w;
  }

  // ---- competition categories (gender x age bracket) -------------------
  function ageFrom(birthDate) {
    if (!birthDate) return null;
    var b = new Date(birthDate), n = new Date();
    var a = n.getFullYear() - b.getFullYear();
    var m = n.getMonth() - b.getMonth();
    if (m < 0 || (m === 0 && n.getDate() < b.getDate())) a--;
    return a;
  }
  // -> "teen men" | "teen women" | "elite men" | "elite women" | "masters men" | "masters women"
  function categoryOf(gender, birthDate) {
    if (!gender || !birthDate) return null;
    var a = ageFrom(birthDate);
    if (a == null) return null;
    var bracket = a < 18 ? "teen" : (a < 35 ? "elite" : "masters");
    return bracket + " " + (gender === "female" ? "women" : "men");
  }
  window.cfbyCategoryOf = categoryOf;   // the app uses this for filtering/rankings

  // ---- Supabase writes (debounced) ------------------------------------
  // DIRTY_KEY holds the timestamp of the last tracker write that has not been
  // confirmed as pushed to Supabase. It is the recovery net for the mobile
  // lifecycle: closing the PWA kills the debounce timer (or the push itself),
  // and without this stamp the next boot would clobber the device's newer data
  // with the stale server copy — silently losing the workout the user just
  // logged. See the seeding logic in main().
  var DIRTY_KEY = "cfby_dirty_v1";
  function rawGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }

  // ---- sync status badge ------------------------------------------------
  // The user must SEE sync state — silent failures are exactly how workouts
  // got lost before. One small pill, bottom-left, never intercepts touches.
  var syncHideT = null;
  function syncShow(kind) {
    if (!document.body) return;
    var el = document.getElementById("cfbySync");
    if (!el) {
      el = document.createElement("div");
      el.id = "cfbySync";
      el.style.cssText =
        "position:fixed;left:10px;bottom:calc(10px + env(safe-area-inset-bottom,0px));z-index:99990;" +
        "color:#fff;font:600 12px 'Heebo',system-ui,sans-serif;padding:6px 12px;border-radius:20px;direction:rtl;" +
        "box-shadow:0 4px 14px rgba(0,0,0,.25);pointer-events:none;transition:opacity .25s;opacity:0";
      document.body.appendChild(el);
    }
    clearTimeout(syncHideT);
    if (kind === "saving")       { el.textContent = "⏳ שומר…";                        el.style.background = "#233657"; }
    else if (kind === "saved")   { el.textContent = "✓ נשמר בענן";                    el.style.background = "#1e7e46"; }
    else if (kind === "error")   { el.textContent = "⚠️ לא מסונכרן — מנסה שוב";       el.style.background = "#a33b2e"; }
    else if (kind === "offline") { el.textContent = "📡 אין אינטרנט — יסונכרן כשיחזור"; el.style.background = "#8a6d1a"; }
    el.style.opacity = "1";
    if (kind === "saved") syncHideT = setTimeout(function () { el.style.opacity = "0"; }, 1600);
  }
  window.__cfbySync = syncShow;

  // ---- self-update ------------------------------------------------------
  // version.json is bumped on every deploy. If the server says a newer build
  // exists and everything is synced, reload — the SW is network-first, so the
  // reload picks up the new bundle. One attempt per build (no reload loops),
  // and NEVER over unsynced data.
  async function checkFreshBundle() {
    try {
      var r = await fetch("version.json?t=" + Date.now(), { cache: "no-store" });
      if (!r.ok) return;
      var j = await r.json();
      if (!j || !j.build || j.build === BUILD) return;
      if (rawGet(DIRTY_KEY) !== null) return;
      if (rawGet("cfby_upd_v1") === j.build) return;
      try { localStorage.setItem("cfby_upd_v1", j.build); } catch (e) {}
      location.reload();
    } catch (e) {}
  }
  // Tiny build tag so "which code is my phone actually running?" is answerable
  // with one glance instead of another guessing round.
  function versionTag() {
    if (!document.body || document.getElementById("cfbyVer")) return;
    var el = document.createElement("div");
    el.id = "cfbyVer";
    el.textContent = "v" + BUILD;
    el.style.cssText = "position:fixed;right:8px;bottom:calc(4px + env(safe-area-inset-bottom,0px));z-index:99989;" +
      "font:400 9px monospace;color:rgba(0,0,0,.35);pointer-events:none;direction:ltr";
    document.body.appendChild(el);
  }

  // A push that fails on a stale JWT (app resumed from background after the
  // token expired) refreshes the session once and retries.
  async function upsertWithRetry(table, row) {
    var r = await sb.from(table).upsert(row);
    if (r.error) {
      try { await sb.auth.refreshSession(); } catch (e) {}
      r = await sb.from(table).upsert(row);
    }
    return r;
  }

  var t1 = null, t2 = null, retryT = null;
  var pushCtx = { uid: null, isAdmin: false };

  async function doPushState() {
    if (!pushCtx.uid) return;
    var tracker = lsGet(K.TRACKER_KEY);
    if (!tracker) return;
    var stamp = rawGet(DIRTY_KEY);
    if (stamp !== null) syncShow("saving");
    var r = await upsertWithRetry("states", { user_id: pushCtx.uid, tracker: tracker, updated_at: new Date().toISOString() });
    if (r.error) {
      console.error("[sync] states push failed:", r.error.message || r.error);
      syncShow(navigator.onLine === false ? "offline" : "error");
      clearTimeout(retryT);
      retryT = setTimeout(doPushState, 10000);   // dirty stamp survives either way
      return;
    }
    // Clear the dirty stamp only if nothing was written while the push was in
    // flight — a newer write must stay marked as unsynced.
    if (stamp !== null && rawGet(DIRTY_KEY) === stamp) {
      try { localStorage.removeItem(DIRTY_KEY); } catch (e) {}
      syncShow("saved");
    }
    // Admin also publishes the program scaffold for everyone — STRIPPED of the
    // admin's own logs (see stripLogs above).
    if (pushCtx.isAdmin && tracker.weeks) {
      await upsertWithRetry("shared_program", { id: 1, weeks: stripLogs(tracker.weeks), updated_at: new Date().toISOString() });
    }
  }
  function pushState() {
    clearTimeout(t1);
    t1 = setTimeout(function () { t1 = null; doPushState(); }, 800);
  }
  // Per-week summary the leaderboard needs: completed days + shared result.
  // A day counts twice when its alternate session is also done — this must match
  // the app's own weekStats(), or a user's rank would disagree with their screen.
  function summarizeWeeks(tracker, myResults) {
    var out = [], wk = (tracker && tracker.weeks) || [];
    for (var i = 0; i < wk.length; i++) {
      var days = (wk[i] && wk[i].days) || [], done = 0;
      for (var j = 0; j < days.length; j++) {
        if (!days[j]) continue;
        if (days[j].done) done++;
        if (days[j].alt && days[j].alt.done) done++;
      }
      out.push({ completed: done, result: (myResults && myResults[i]) || 0 });
    }
    return out;
  }
  // Per-metcon comparable results for the ranking engine. Keys MUST match the
  // app's weekMetconsFromData(): "w_d" (main), "w_d_2", "w_d_a", "w_d_a2".
  // time -> seconds (lower = better); rounds*100000+reps / amount (higher = better).
  function metconEntry(m) {
    if (!m) return null;
    var M = m.log || {};
    var mode = m.resultMode || M.mode || "time";
    if (mode === "time") {
      if (!M.time) return null;
      var p = String(M.time).trim().split(":").map(Number);
      if (!p.length || p.some(function (x) { return isNaN(x); })) return null;
      var s = p.length === 3 ? p[0]*3600 + p[1]*60 + p[2] : (p.length === 2 ? p[0]*60 + p[1] : p[0]);
      return s > 0 ? { v: s, dir: "low", rx: !!m.rx } : null;
    }
    if (mode === "amount") { var a = parseFloat(M.amount); return a > 0 ? { v: a, dir: "high", rx: !!m.rx } : null; }
    var r = (parseInt(M.rounds, 10) || 0) * 100000 + (parseInt(M.reps, 10) || 0);
    return r > 0 ? { v: r, dir: "high", rx: !!m.rx } : null;
  }
  function extractMetcons(tracker) {
    var out = {}, wk = (tracker && tracker.weeks) || [];
    for (var w = 0; w < wk.length; w++) {
      var days = (wk[w] && wk[w].days) || [];
      for (var d = 0; d < days.length; d++) {
        var day = days[d]; if (!day) continue;
        var e1 = metconEntry(day.metcon);  if (e1) out[w + "_" + d] = e1;
        var e2 = metconEntry(day.metcon2); if (e2) out[w + "_" + d + "_2"] = e2;
        if (day.alt) {
          var a1 = metconEntry(day.alt.metcon);  if (a1) out[w + "_" + d + "_a"] = a1;
          var a2 = metconEntry(day.alt.metcon2); if (a2) out[w + "_" + d + "_a2"] = a2;
        }
      }
    }
    return out;
  }

  // Public profile summary — the small card anyone can open from the board.
  // Only aggregate counters + the last 3 PRs leave the device; the full private
  // tracker stays in `states`. Counter thresholds must match the app's
  // badgeList() or a viewer would see different badges than the owner does.
  function publicSummary(tracker, myTarget) {
    var wk = (tracker && tracker.weeks) || [];
    var target = parseInt(myTarget, 10) || 5;
    var t = 0, best = 0, run = 0, p = 0, rx = 0, r9 = 0, fw = 0, prs = [];
    function prSummary(dd) {
      var parts = [];
      var L = (dd.lift && dd.lift.log) || {};
      if (L.weight || L.reps) parts.push([L.weight && (L.weight + "kg"), L.reps && (L.reps + " reps")].filter(Boolean).join(" × "));
      var M = (dd.metcon && dd.metcon.log) || {};
      if (M.mode === "time" && M.time) parts.push(M.time);
      else if (M.rounds || M.reps) parts.push([M.rounds && (M.rounds + " rds"), M.reps && (M.reps + " reps")].filter(Boolean).join(" + "));
      return parts.join(" · ");
    }
    for (var w = 0; w < wk.length; w++) {
      var days = (wk[w] && wk[w].days) || [], wDone = 0;
      for (var d = 0; d < days.length; d++) {
        var day = days[d]; if (!day) continue;
        if (day.done) { t++; wDone++; }
        if (day.alt && day.alt.done) { t++; wDone++; }
        if (day.done || (day.alt && day.alt.done)) { run++; if (run > best) best = run; } else run = 0;
        var sessions = [day, day.alt];
        for (var s = 0; s < sessions.length; s++) {
          var dd = sessions[s]; if (!dd) continue;
          if (dd.pr || dd.rating === "pr") {
            p++;
            var move = (dd.lift && dd.lift.movement) || (dd.metcon && dd.metcon.name) || "אימון";
            prs.push({ move: move, res: prSummary(dd), week: "W" + (w + 1) });
          }
          if (dd.done && parseInt(dd.rating, 10) >= 9) r9++;
          var e1 = metconEntry(dd.metcon);  if (e1 && e1.rx) rx++;
          var e2 = metconEntry(dd.metcon2); if (e2 && e2.rx) rx++;
        }
      }
      if (wDone >= target) fw++;
    }
    return { t: t, s: best, p: p, rx: rx, r9: r9, fw: fw, prs: prs.slice(-3).reverse() };
  }

  async function doPushBoard() {
    if (!pushCtx.uid) return;
    var b = lsGet(K.BOARD_KEY) || {};
    var tracker = lsGet(K.TRACKER_KEY);
    var r = await upsertWithRetry("board", {
      user_id: pushCtx.uid,
      name: b.myName || "",
      results: b.myResults || {},
      weeks: summarizeWeeks(tracker, b.myResults),
      metcons: extractMetcons(tracker),
      pub: publicSummary(tracker, b.myTarget),
      updated_at: new Date().toISOString()
    });
    // No retry loop needed: the board row is derived from the tracker and is
    // rebuilt+pushed on every boot, so a lost board push self-heals.
    if (r.error) console.error("[sync] board push failed:", r.error.message || r.error);
  }
  function pushBoard() {
    // Admins compete on the leaderboard like everyone else (their extra powers
    // are the panel + program editing, not board visibility).
    clearTimeout(t2);
    t2 = setTimeout(function () { t2 = null; doPushBoard(); }, 800);
  }

  // A push that has to survive the page being killed (PWA closed / backgrounded)
  // cannot go through supabase-js — its fetch dies with the page. keepalive
  // hands the request to the browser's network stack, which finishes it even
  // after the page is gone. Falls back silently on any failure (e.g. the 64KB
  // keepalive body limit): the dirty stamp + boot-time recovery still cover it.
  var accessToken = null;
  sb.auth.onAuthStateChange(function (_e, s) { accessToken = (s && s.access_token) || null; });
  function keepalivePush() {
    if (!pushCtx.uid || !accessToken) return;
    var raw = rawGet(K.TRACKER_KEY);
    var stamp = rawGet(DIRTY_KEY);
    if (!raw || stamp === null) return;
    try {
      fetch(window.SUPA_URL + "/rest/v1/states?on_conflict=user_id", {
        method: "POST",
        keepalive: true,
        headers: {
          apikey: window.SUPA_ANON_KEY,
          Authorization: "Bearer " + accessToken,
          "Content-Type": "application/json",
          Prefer: "resolution=merge-duplicates"
        },
        body: JSON.stringify({ user_id: pushCtx.uid, tracker: JSON.parse(raw), updated_at: new Date().toISOString() })
      }).then(function (res) {
        if (res.ok && rawGet(DIRTY_KEY) === stamp) { try { localStorage.removeItem(DIRTY_KEY); } catch (e) {} }
      }).catch(function () {});
    } catch (e) {}
  }

  // The debounce is the enemy on phones: switching away from the PWA can kill
  // the page before an 800ms timer fires. Flush pending pushes the moment the
  // page goes hidden — through BOTH channels (normal push may die with the
  // page; keepalive survives it).
  function flushPending() {
    if (t1) { clearTimeout(t1); t1 = null; doPushState(); }
    if (t2) { clearTimeout(t2); t2 = null; doPushBoard(); }
  }
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") { flushPending(); keepalivePush(); }
    else if (document.visibilityState === "visible" && pushCtx.uid) {
      // Coming back to a live PWA: sync anything pending right away, and ask
      // the server whether a newer build exists (precise, replaces the old
      // 12h-age heuristic) — installed PWAs keep pages alive for days, which
      // is how devices kept running old (buggy) bundles after a fix shipped.
      if (rawGet(DIRTY_KEY) !== null) { doPushState(); doPushBoard(); }
      else checkFreshBundle();
    }
  });
  window.addEventListener("pagehide", function () { flushPending(); keepalivePush(); });
  // Push again when connectivity returns, in case a push failed offline.
  window.addEventListener("online", function () {
    if (rawGet(DIRTY_KEY) !== null) { doPushState(); doPushBoard(); }
  });
  window.addEventListener("offline", function () {
    if (rawGet(DIRTY_KEY) !== null) syncShow("offline");
  });
  // Belt & braces: anything still unsynced is retried every 15s while the app
  // is open — covers a retry timer lost to tab suspension. Skipped when a
  // debounced push is already scheduled.
  setInterval(function () {
    if (pushCtx.uid && !t1 && rawGet(DIRTY_KEY) !== null && navigator.onLine !== false) doPushState();
  }, 15000);

  // When boot.js itself rewrites the board (e.g. a realtime refresh of other
  // athletes), suppress the interceptor so it does not push our own row back
  // and cause an echo loop.
  var suppressPush = false;

  // Intercept the app's own localStorage writes
  function installInterceptor(uid, isAdmin) {
    pushCtx.uid = uid; pushCtx.isAdmin = isAdmin;
    var orig = localStorage.setItem.bind(localStorage);
    localStorage.setItem = function (key, val) {
      orig(key, val);
      if (suppressPush) return;
      if (key === K.TRACKER_KEY) {
        // Mark the tracker as unsynced BEFORE scheduling the push; cleared only
        // after Supabase confirms the upsert.
        try { orig(DIRTY_KEY, String(Date.now())); } catch (e) {}
        pushState();
        // A completed workout only writes the tracker, but the leaderboard's
        // "completed" counts are derived from it — so sync the board too, or a
        // user who just marks workouts done never appears on anyone's board.
        pushBoard();
      } else if (key === K.BOARD_KEY) {
        pushBoard();
      }
    };
  }

  // ---- realtime leaderboard -------------------------------------------
  // Refresh ONLY the other athletes' rows (never our own fields) so anyone
  // else's change appears live, without a page refresh.
  var rtTimer = null, rtLast = 0;
  // Each refresh refetches the FULL board + roster on every device. At ~100
  // athletes an evening burst (everyone saving the WOD at once) would make
  // every phone refetch dozens of times — so refreshes are rate-limited to one
  // per RT_MIN_GAP. Reads only; the user's own saves are never delayed by this.
  var RT_MIN_GAP = 15000;
  async function refreshOthers(uid) {
    var fb = await fetchBoard();
    if (fb.error) return;   // keep showing the last good board, never a blank one
    var byId = {}; fb.rows.forEach(function (r) { byId[r.user_id] = r; });
    var profs = await fetchAllProfiles();
    var board = profs
      .filter(function (p) { return p.id !== uid; })
      .map(function (p) { var r = byId[p.id]; return { id: p.id, name: (r && r.name) || p.name || "", weeks: (r && r.weeks) || [], metcons: (r && r.metcons) || {}, category: categoryOf(p.gender, p.birth_date), age: ageFrom(p.birth_date), pub: (r && r.pub) || null }; });
    var cur = lsGet(K.BOARD_KEY) || {};
    cur.board = board;
    suppressPush = true;
    try { lsSetRaw(K.BOARD_KEY, cur); } finally { suppressPush = false; }
    if (window.cfbyReloadBoard) { try { window.cfbyReloadBoard(); } catch (e) {} }
  }
  function subscribeBoard(uid) {
    try {
      sb.channel("cfby-board")
        .on("postgres_changes", { event: "*", schema: "public", table: "board" }, function () {
          if (rtTimer) return;   // a refresh is already on its way — this event rides along
          var wait = Math.max(500, rtLast + RT_MIN_GAP - Date.now());
          rtTimer = setTimeout(function () {
            rtTimer = null; rtLast = Date.now();
            refreshOthers(uid).catch(function () {});
          }, wait);
        })
        .subscribe();
    } catch (e) { console.error("[realtime]", e); }
  }

  // ---- in-app ADMIN panel (only injected for admins) ------------------
  function injectAdminPanel(meId) {
    var DOMAIN = "@batyam.app";
    var css = document.createElement("style");
    css.textContent =
      "#cfbyAdminOv{position:fixed;inset:0;z-index:99999;background:#0e1a33;display:none;align-items:flex-start;justify-content:center;padding:24px 16px;overflow:auto}" +
      "#cfbyAdminOv.open{display:flex}" +
      ".cfa-box{width:100%;max-width:1000px;min-height:calc(100vh - 48px);padding:8px 6px;color:#eaf0ff;font-family:'Heebo',sans-serif;direction:rtl}" +
      ".cfa-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px}" +
      ".cfa-head h2{font-size:19px;font-weight:800}.cfa-head h2 span{color:#ef5b25}" +
      ".cfa-x{background:#1b2b4d;border:1px solid #243657;border-radius:8px;color:#eaf0ff;font:700 13px 'Heebo',sans-serif;padding:8px 14px;cursor:pointer}" +
      ".cfa-add{background:#0f1830;border:1px solid #243657;border-radius:12px;padding:14px;margin-bottom:16px;display:grid;grid-template-columns:1fr 1fr 1fr auto;gap:8px;align-items:end}" +
      ".cfa-add label{font-size:11px;color:#8ea3c9;display:block;margin-bottom:4px}" +
      ".cfa-add input{width:100%;background:#16233f;border:1px solid #243657;border-radius:8px;padding:9px 10px;color:#eaf0ff;font:14px 'Heebo',sans-serif}" +
      ".cfa-add input.ltr{direction:ltr;text-align:left}" +
      ".cfa-add button{background:#2ecc71;color:#062;border:none;border-radius:8px;padding:10px 14px;font:800 13px 'Heebo',sans-serif;cursor:pointer;white-space:nowrap}" +
      ".cfa-msg{font-size:13px;margin:0 0 12px;min-height:16px}.cfa-msg.err{color:#ff8a80}.cfa-msg.ok{color:#7ee2a8}" +
      ".cfa-t{width:100%;border-collapse:collapse}" +
      ".cfa-t th,.cfa-t td{padding:9px 10px;text-align:right;font-size:13px;border-bottom:1px solid #243657}" +
      ".cfa-t th{color:#8ea3c9;font-size:11px;text-transform:uppercase}" +
      ".cfa-badge{font-size:10px;padding:1px 7px;border-radius:12px;background:#ef5b2533;color:#ff9f7a;font-weight:700}" +
      ".cfa-del{background:transparent;border:1px solid #e74c3c;color:#e74c3c;border-radius:6px;padding:5px 10px;font:700 11px 'Heebo',sans-serif;cursor:pointer}" +
      ".cfa-del:hover{background:#e74c3c;color:#fff}" +
      ".cfa-key{background:transparent;border:1px solid #4a90d9;color:#7ab8f5;border-radius:6px;padding:5px 10px;font:700 11px 'Heebo',sans-serif;cursor:pointer;margin-left:6px}" +
      ".cfa-key:hover{background:#4a90d9;color:#fff}" +
      ".cfa-stat{color:#8ea3c9;font-size:12px;margin-bottom:10px}" +
      ".cfa-tools{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:14px}" +
      ".cfa-bk{background:#1b2b4d;border:1px solid #2e4a7d;border-radius:8px;color:#9fc2ff;font:700 12px 'Heebo',sans-serif;padding:8px 12px;cursor:pointer}" +
      ".cfa-bk:hover{background:#2e4a7d;color:#fff}" +
      ".cfa-bkinfo{font-size:12px;color:#8ea3c9}.cfa-bkinfo.warn{color:#ffb74d;font-weight:700}" +
      ".cfa-ann{background:#0f1830;border:1px solid #243657;border-radius:12px;padding:14px;margin-bottom:16px}" +
      ".cfa-ann h3{font-size:14px;font-weight:800;margin:0 0 4px;color:#eaf0ff}" +
      ".cfa-ann .sub{font-size:11px;color:#8ea3c9;margin:0 0 10px}" +
      ".cfa-ann input,.cfa-ann textarea{width:100%;background:#16233f;border:1px solid #243657;border-radius:8px;padding:9px 10px;color:#eaf0ff;font:14px 'Heebo',sans-serif;margin-bottom:8px;box-sizing:border-box}" +
      ".cfa-ann textarea{resize:vertical;min-height:90px}" +
      ".cfa-ann .row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}" +
      ".cfa-pub{background:#ef5b25;color:#fff;border:none;border-radius:8px;padding:10px 14px;font:800 13px 'Heebo',sans-serif;cursor:pointer}" +
      ".cfa-prev{background:#1b2b4d;border:1px solid #2e4a7d;color:#9fc2ff;border-radius:8px;padding:10px 14px;font:700 12px 'Heebo',sans-serif;cursor:pointer}" +
      ".cfa-annclr{background:transparent;border:1px solid #e74c3c;color:#e74c3c;border-radius:8px;padding:10px 14px;font:700 12px 'Heebo',sans-serif;cursor:pointer}" +
      ".cfa-annst{font-size:12px;color:#8ea3c9}";
    document.head.appendChild(css);

    var ov = document.createElement("div");
    ov.id = "cfbyAdminOv";
    ov.innerHTML =
      '<div class="cfa-box">' +
        '<div class="cfa-head"><h2><span>👥</span> ניהול משתתפים</h2><button class="cfa-x" id="cfaX">✕ סגור</button></div>' +
        '<div class="cfa-add">' +
          '<div><label>שם משתמש (אנגלית)</label><input id="cfaU" class="ltr" placeholder="username"></div>' +
          '<div><label>שם לתצוגה</label><input id="cfaN" placeholder="השם"></div>' +
          '<div><label>סיסמה</label><input id="cfaP" class="ltr" placeholder="סיסמה"></div>' +
          '<button id="cfaAdd">+ הוסף</button>' +
        '</div>' +
        '<div class="cfa-tools">' +
          '<button class="cfa-bk" id="cfaBk">💾 גיבוי לקובץ</button>' +
          '<button class="cfa-bk" id="cfaRs">♻️ שחזור מגיבוי</button>' +
          '<span class="cfa-bkinfo" id="cfaBkInfo"></span>' +
          '<input type="file" id="cfaRsFile" accept="application/json,.json" style="display:none">' +
        '</div>' +
        '<div class="cfa-ann">' +
          '<h3>📣 הודעת בלוק חדש</h3>' +
          '<p class="sub">תוצג כפופאפ חגיגי 🎖️ עם קונפטי — פעם אחת לכל מתאמן, בכניסה הבאה שלו לאפליקציה.</p>' +
          '<input id="cfaAnnT" placeholder="כותרת — למשל: בלוק חדש יוצא לדרך! 🎉">' +
          '<textarea id="cfaAnnB" placeholder="דגשים, הערות, רעיונות והכנה לבלוק…"></textarea>' +
          '<div class="row">' +
            '<button class="cfa-pub" id="cfaAnnPub">📣 פרסם לכולם</button>' +
            '<button class="cfa-prev" id="cfaAnnPrev">👁 תצוגה מקדימה</button>' +
            '<button class="cfa-annclr" id="cfaAnnClr">🗑 הסר הודעה</button>' +
            '<span class="cfa-annst" id="cfaAnnSt"></span>' +
          '</div>' +
        '</div>' +
        '<p class="cfa-msg" id="cfaMsg"></p>' +
        '<p class="cfa-stat" id="cfaStat"></p>' +
        '<div id="cfaList">טוען…</div>' +
      '</div>';
    document.body.appendChild(ov);

    function amsg(t, cls) { var m = document.getElementById("cfaMsg"); m.textContent = t || ""; m.className = "cfa-msg " + (cls || ""); }
    function fmtWhen(s){ if(!s) return "—"; try{ var d=new Date(s),n=new Date(),diff=(n-d)/86400000;
      if(diff<1) return "היום"; if(diff<2) return "אתמול"; if(diff<7) return Math.floor(diff)+" ימים";
      return d.toLocaleDateString("he-IL",{day:"2-digit",month:"2-digit",year:"2-digit"});}catch(e){return "—";} }

    async function refresh() {
      var profs = await sb.from("profiles").select("id,name,email,is_admin,created_at");
      if (profs.error) { document.getElementById("cfaList").textContent = "שגיאה: " + profs.error.message; return; }
      var st = await sb.from("states").select("user_id,updated_at");
      var bd = await sb.from("board").select("user_id,results");
      var sMap = {}, bMap = {};
      (st.data || []).forEach(function (r) { sMap[r.user_id] = r; });
      (bd.data || []).forEach(function (r) { bMap[r.user_id] = r; });
      var users = (profs.data || []).sort(function (a, b) { return (a.name || "").localeCompare(b.name || ""); });
      var active = users.filter(function (u) { return sMap[u.id]; }).length;
      document.getElementById("cfaStat").textContent = users.length + " משתמשים · " + active + " התחילו למלא";
      var rows = users.map(function (u) {
        var s = sMap[u.id], b = bMap[u.id];
        var logged = b && b.results ? Object.keys(b.results).length : 0;
        var isMe = u.id === meId;
        return '<tr><td>' + (u.name || "—") + (u.is_admin ? ' <span class="cfa-badge">Admin</span>' : '') + (isMe ? ' (אתה)' : '') + '</td>' +
          '<td style="direction:ltr;text-align:right;color:#8ea3c9">' + (u.email || "—") + '</td>' +
          '<td>' + fmtWhen(s ? s.updated_at : null) + '</td>' +
          '<td>' + logged + '</td>' +
          '<td><button class="cfa-key" data-id="' + u.id + '" data-name="' + (u.name || "") + '">🔑 סיסמה</button>' +
            (isMe ? '' : '<button class="cfa-del" data-id="' + u.id + '" data-name="' + (u.name || "") + '">מחק</button>') + '</td></tr>';
      }).join("");
      document.getElementById("cfaList").innerHTML =
        '<table class="cfa-t"><thead><tr><th>שם</th><th>שם משתמש</th><th>פעילות</th><th>אימונים</th><th></th></tr></thead><tbody>' + rows + '</tbody></table>';
      Array.prototype.forEach.call(document.querySelectorAll(".cfa-del"), function (b) {
        b.onclick = function () { del(b.getAttribute("data-id"), b.getAttribute("data-name")); };
      });
      Array.prototype.forEach.call(document.querySelectorAll(".cfa-key"), function (b) {
        b.onclick = function () { resetPass(b.getAttribute("data-id"), b.getAttribute("data-name")); };
      });
    }

    // ---- backup / restore ------------------------------------------------
    // The free Supabase tier has NO automatic backups — one bad delete and the
    // data is gone forever. This exports every table to a JSON file on the
    // admin's device; restore upserts it back row by row. RLS already grants
    // admins full read/write on all four tables, so no server changes needed.
    var BK_KEY = "cfby_backup_last";
    function bkInfo() {
      var el = document.getElementById("cfaBkInfo");
      if (!el) return;
      var t = parseInt(rawGet(BK_KEY), 10) || 0;
      if (!t) { el.textContent = "⚠️ עדיין לא נעשה גיבוי מהמכשיר הזה"; el.className = "cfa-bkinfo warn"; return; }
      var days = Math.floor((Date.now() - t) / 86400000);
      el.textContent = days < 1 ? "גיבוי אחרון: היום" : (days === 1 ? "גיבוי אחרון: אתמול" : "גיבוי אחרון: לפני " + days + " ימים");
      el.className = "cfa-bkinfo" + (days >= 7 ? " warn" : "");
    }

    async function backup() {
      amsg("מוריד את כל הנתונים מהענן…");
      try {
        var q = await Promise.all([
          sb.from("profiles").select("*"),
          sb.from("states").select("*"),
          sb.from("board").select("*"),
          sb.from("shared_program").select("*")
        ]);
        // A partial backup is worse than none — it restores silently incomplete.
        for (var i = 0; i < q.length; i++) if (q[i].error) throw q[i].error;
        var payload = {
          format: "cfby-backup", ver: 1,
          created_at: new Date().toISOString(), build: BUILD,
          profiles: q[0].data || [], states: q[1].data || [],
          board: q[2].data || [], shared_program: q[3].data || []
        };
        var stamp = payload.created_at.slice(0, 16).replace("T", "_").replace(":", "");
        var blob = new Blob([JSON.stringify(payload)], { type: "application/json" });
        var a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = "batyam-backup-" + stamp + ".json";
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
        try { localStorage.setItem(BK_KEY, String(Date.now())); } catch (e) {}
        bkInfo();
        amsg("הגיבוי ירד למכשיר: " + payload.profiles.length + " משתמשים, " +
             payload.states.length + " טבלאות תוצאות. שמור את הקובץ במקום בטוח (דרייב/מחשב).", "ok");
      } catch (e) {
        amsg("הגיבוי נכשל: " + ((e && e.message) || e), "err");
      }
    }

    async function restore(file) {
      var data;
      try { data = JSON.parse(await file.text()); }
      catch (e) { amsg("הקובץ שנבחר אינו קובץ גיבוי תקין", "err"); return; }
      if (!data || data.format !== "cfby-backup" || !Array.isArray(data.profiles)) {
        amsg("הקובץ שנבחר אינו קובץ גיבוי של המערכת", "err"); return;
      }
      var when = data.created_at ? new Date(data.created_at).toLocaleString("he-IL") : "תאריך לא ידוע";
      if (!confirm("לשחזר גיבוי מ-" + when + "?\n" +
                   data.profiles.length + " משתמשים, " + (data.states || []).length + " טבלאות תוצאות.\n\n" +
                   "נתונים קיימים בענן יידרסו על ידי הגיבוי. מומלץ לעשות גיבוי טרי לפני השחזור.")) return;
      // Row-by-row on purpose: a member deleted since the backup still has rows
      // in the file, and their FK to auth.users fails — one batched upsert
      // would take the whole table down with it; per-row just skips them.
      var ok = 0, skip = 0;
      async function putRows(table, rows, key) {
        for (var i = 0; i < rows.length; i++) {
          var r = await sb.from(table).upsert(rows[i], { onConflict: key });
          if (r.error) skip++; else ok++;
          if ((ok + skip) % 20 === 0) amsg("משחזר… " + (ok + skip) + " רשומות");
        }
      }
      amsg("משחזר…");
      await putRows("profiles", data.profiles || [], "id");
      await putRows("states", data.states || [], "user_id");
      await putRows("board", data.board || [], "user_id");
      await putRows("shared_program", data.shared_program || [], "id");
      amsg("השחזור הסתיים: " + ok + " רשומות שוחזרו" +
           (skip ? ", " + skip + " דולגו (כנראה משתמשים שנמחקו מאז הגיבוי)" : "") +
           ". משתתפים יראו את הנתונים בפתיחה הבאה של האפליקציה.", skip ? "" : "ok");
      refresh();
    }

    // ---- block announcement (compose / publish / clear) ------------------
    // Publishing swaps in a NEW id, so everyone (including people who saw the
    // previous announcement) gets the popup exactly once more.
    async function annStatus() {
      var el = document.getElementById("cfaAnnSt");
      if (!el) return;
      try {
        var r = await sb.from("shared_program").select("announcement").eq("id", 1).maybeSingle();
        var a = r.data && r.data.announcement;
        if (a && a.id) {
          var when = a.created_at ? new Date(a.created_at).toLocaleDateString("he-IL") : "";
          el.textContent = 'פעילה: "' + (a.title || "") + '"' + (when ? " · " + when : "");
          // seed the editor with the live announcement so a small fix doesn't
          // mean retyping it — but never clobber text the admin already typed
          var t = document.getElementById("cfaAnnT"), b = document.getElementById("cfaAnnB");
          if (t && !t.value) t.value = a.title || "";
          if (b && !b.value) b.value = a.body || "";
        } else el.textContent = "אין הודעה פעילה";
      } catch (e) { el.textContent = ""; }
    }
    function annDraft() {
      return { title: (document.getElementById("cfaAnnT").value || "").trim(),
               body:  (document.getElementById("cfaAnnB").value || "").trim() };
    }
    async function annPublish() {
      var d = annDraft();
      if (!d.title && !d.body) { amsg("כתוב כותרת או תוכן להודעה", "err"); return; }
      var ann = { id: "a" + Date.now(), title: d.title || "בלוק חדש התחיל!", body: d.body, created_at: new Date().toISOString() };
      amsg("מפרסם…");
      var r = await sb.from("shared_program").upsert({ id: 1, announcement: ann });
      if (r.error) {
        var m = r.error.message || String(r.error);
        if (/announcement/.test(m) && /column|schema/i.test(m))
          m = "עמודת announcement חסרה ב-Supabase — יש להריץ את supabase/schema.sql ב-SQL Editor ואז לנסות שוב";
        amsg("הפרסום נכשל: " + m, "err"); return;
      }
      // the author doesn't need their own popup — mark it seen for the admin
      try { localStorage.setItem("cfby_ann_seen", ann.id); } catch (e) {}
      await sb.from("profiles").upsert({ id: meId, announcement_seen: ann.id });
      amsg("ההודעה פורסמה — כל מתאמן יראה אותה פעם אחת בכניסה הבאה שלו 🎖️", "ok");
      annStatus();
    }
    async function annClear() {
      if (!confirm("להסיר את ההודעה הפעילה?\nמי שעדיין לא ראה אותה — כבר לא יראה אותה.")) return;
      var r = await sb.from("shared_program").upsert({ id: 1, announcement: null });
      if (r.error) { amsg("ההסרה נכשלה: " + (r.error.message || r.error), "err"); return; }
      document.getElementById("cfaAnnT").value = ""; document.getElementById("cfaAnnB").value = "";
      amsg("ההודעה הוסרה", "ok"); annStatus();
    }

    // Passwords exist only as bcrypt hashes in Supabase — showing a member's
    // current password is impossible, so "forgot password" = admin assigns a
    // new one here and passes it on.
    async function resetPass(uid, name) {
      var p = prompt('סיסמה חדשה עבור "' + (name || "המשתמש") + '" (לפחות 6 תווים):');
      if (p === null) return;
      p = p.trim();
      if (p.length < 6) { amsg("סיסמה: לפחות 6 תווים", "err"); return; }
      amsg("מעדכן סיסמה…");
      try {
        var r = await sb.rpc("admin_set_password", { target: uid, new_password: p });
        if (r.error) throw r.error;
        amsg('הסיסמה של "' + (name || "המשתמש") + '" שונתה. מסור לו את הסיסמה החדשה: ' + p, "ok");
      } catch (e) {
        var m = (e && e.message) || String(e);
        // The RPC lives in supabase/schema.sql — see the same note in del().
        if (/admin_set_password/.test(m) && /schema cache|find the function/i.test(m))
          m = "הפונקציה admin_set_password חסרה ב-Supabase — יש להריץ את supabase/schema.sql ב-SQL Editor ואז לנסות שוב";
        amsg("שינוי הסיסמה נכשל: " + m, "err");
      }
    }

    async function del(uid, name) {
      if (!confirm('למחוק לצמיתות את "' + (name || "המשתמש") + '"?\nהחשבון וכל הנתונים יימחקו והוא לא יוכל להתחבר יותר.')) return;
      try {
        // admin_delete_user removes the auth account too (cascades to all tables),
        // so a deleted user truly can't sign back in.
        var r = await sb.rpc("admin_delete_user", { target: uid });
        if (r.error) throw r.error;
        amsg("נמחק.", "ok"); refresh();
      } catch (e) {
        var m = (e && e.message) || String(e);
        // The RPC lives in supabase/schema.sql — a fresh/reset DB won't have it
        // until the schema is (re)run in the Supabase SQL Editor.
        if (/admin_delete_user/.test(m) && /schema cache|find the function/i.test(m))
          m = "הפונקציה admin_delete_user חסרה ב-Supabase — יש להריץ את supabase/schema.sql ב-SQL Editor ואז לנסות שוב";
        amsg("מחיקה נכשלה: " + m, "err");
      }
    }

    async function addUser() {
      var u = (document.getElementById("cfaU").value || "").trim().toLowerCase();
      var n = (document.getElementById("cfaN").value || "").trim();
      var p = document.getElementById("cfaP").value || "";
      if (!/^[a-z0-9._-]{3,30}$/.test(u)) { amsg("שם משתמש: 3-30 תווים, אנגלית/מספרים", "err"); return; }
      if (p.length < 6) { amsg("סיסמה: לפחות 6 תווים", "err"); return; }
      amsg("יוצר…");
      try {
        // throwaway client so creating the account does NOT log the admin out
        var tmp = window.supabase.createClient(window.SUPA_URL, window.SUPA_ANON_KEY,
          { auth: { persistSession: false, autoRefreshToken: false } });
        var r = await tmp.auth.signUp({ email: u + DOMAIN, password: p });
        if (r.error) throw r.error;
        var newId = r.data.user && r.data.user.id;
        if (newId) {
          var up = await sb.from("profiles").upsert({ id: newId, name: (n || u), email: u });
          if (up.error) throw up.error;   // surface RLS/other failures instead of a false "created"
        }
        document.getElementById("cfaU").value = ""; document.getElementById("cfaN").value = ""; document.getElementById("cfaP").value = "";
        amsg('נוצר "' + (n || u) + '". מסור לו שם משתמש: ' + u, "ok");
        refresh();
      } catch (e) {
        var m = (e && e.message) || "שגיאה";
        if (/already registered|already exists/i.test(m)) m = "שם המשתמש כבר תפוס";
        amsg(m, "err");
      }
    }

    function openPanel() { ov.classList.add("open"); bkInfo(); annStatus(); refresh(); }
    document.getElementById("cfaAnnPub").onclick = annPublish;
    document.getElementById("cfaAnnClr").onclick = annClear;
    document.getElementById("cfaAnnPrev").onclick = function () {
      var d = annDraft();
      window.__cfbyAnnPreview({ title: d.title || "בלוק חדש התחיל!", body: d.body }, function () {});
    };
    document.getElementById("cfaX").onclick = function () { ov.classList.remove("open"); amsg(""); };
    ov.onclick = function (e) { if (e.target === ov) { ov.classList.remove("open"); amsg(""); } };
    document.getElementById("cfaAdd").onclick = addUser;
    document.getElementById("cfaBk").onclick = backup;
    var rsFile = document.getElementById("cfaRsFile");
    document.getElementById("cfaRs").onclick = function () { rsFile.value = ""; rsFile.click(); };
    rsFile.onchange = function () { if (rsFile.files && rsFile.files[0]) restore(rsFile.files[0]); };

    // Inject a "משתתפים" tab into the top bar, right next to the "❓ מדריך" button.
    // The app may re-render its header, so a MutationObserver re-inserts it if removed.
    function findGuideBtn() {
      var btns = document.querySelectorAll("button");
      for (var i = 0; i < btns.length; i++) {
        var t = (btns[i].textContent || "");
        if (t.indexOf("מדריך") >= 0 && !btns[i].__cfbyTab) return btns[i];
      }
      return null;
    }
    // The app's own "admin mode" (logo -> code "batyam") lives in this key.
    function appAdminMode() { try { return localStorage.getItem("cfby_admin") === "1"; } catch (e) { return false; } }
    function ensureTab() {
      var existing = document.getElementById("cfbyAdminTab");
      // User management is only relevant inside the app's admin mode.
      if (!appAdminMode()) {
        if (existing) existing.remove();
        ov.classList.remove("open");        // close the panel if admin mode was just exited
        return;
      }
      if (existing) return;
      var guide = findGuideBtn();
      if (!guide) return;
      var tab = document.createElement("button");
      tab.id = "cfbyAdminTab"; tab.__cfbyTab = true;
      tab.textContent = "👥 משתתפים";
      tab.style.cssText = guide.style.cssText;           // match the guide button exactly
      tab.onclick = openPanel;
      guide.parentNode.insertBefore(tab, guide.nextSibling); // place it beside the guide
    }
    ensureTab();
    var mo = new MutationObserver(function () { ensureTab(); });
    mo.observe(document.body, { childList: true, subtree: true });
    // safety net: keep trying for ~12s in case the header mounts late
    var tries = 0, iv = setInterval(function () { ensureTab(); if (++tries > 48) clearInterval(iv); }, 250);

    // Deterministic reaction to admin-mode enter/exit, with NO refresh needed:
    // the app writes cfby_admin='1' on entry and removes it on exit. Hook both
    // so the tab appears/disappears the instant admin mode toggles.
    var _lsSet = localStorage.setItem.bind(localStorage);
    var _lsRem = localStorage.removeItem.bind(localStorage);
    localStorage.setItem = function (k, v) { _lsSet(k, v); if (k === "cfby_admin") ensureTab(); };
    localStorage.removeItem = function (k) { _lsRem(k); if (k === "cfby_admin") ensureTab(); };
  }

  // ---- first-login mini-onboarding: gender + birth date ----------------
  function askProfileDetails() {
    return new Promise(function (resolve) {
      var css = document.createElement("style");
      css.textContent =
        "#cfbyOnb{position:fixed;inset:0;z-index:100000;background:linear-gradient(160deg,#0f1830,#1a2848 60%,#23409a);display:flex;align-items:center;justify-content:center;padding:20px;font-family:'Heebo',system-ui,sans-serif;direction:rtl}" +
        "#cfbyOnb .box{background:#16233f;border:1px solid #243657;border-radius:20px;padding:28px 26px;width:100%;max-width:380px;box-shadow:0 20px 60px rgba(0,0,0,.5)}" +
        "#cfbyOnb h2{color:#eaf0ff;font-size:20px;font-weight:800;margin:0 0 4px;text-align:center}" +
        "#cfbyOnb .sub{color:#8ea3c9;font-size:13px;text-align:center;margin:0 0 18px}" +
        "#cfbyOnb label{display:block;color:#8ea3c9;font-size:12px;margin:14px 0 7px}" +
        "#cfbyOnb .gwrap{display:flex;gap:10px}" +
        "#cfbyOnb .g{flex:1;background:#0f1830;border:1px solid #243657;border-radius:12px;padding:12px;color:#eaf0ff;font:700 14px 'Heebo',sans-serif;cursor:pointer;transition:all .15s}" +
        "#cfbyOnb .g.sel{background:#ef5b25;border-color:#ef5b25;color:#fff}" +
        "#cfbyOnb input{width:100%;background:#0f1830;border:1px solid #243657;border-radius:12px;padding:12px 14px;color:#eaf0ff;font:15px 'Heebo',sans-serif;outline:none;color-scheme:dark}" +
        "#cfbyOnb .go{width:100%;margin-top:22px;background:#ef5b25;color:#fff;border:none;border-radius:12px;padding:13px;font:800 15px 'Heebo',sans-serif;cursor:pointer}" +
        "#cfbyOnb .go:disabled{opacity:.5;cursor:default}";
      document.head.appendChild(css);
      var ov = document.createElement("div");
      ov.id = "cfbyOnb";
      ov.innerHTML =
        '<div class="box">' +
          '<h2>👋 בוא נכיר</h2>' +
          '<p class="sub">פרטים לקטגוריית התחרות שלך</p>' +
          '<label>מין</label>' +
          '<div class="gwrap"><button class="g" data-g="male">זכר</button><button class="g" data-g="female">נקבה</button></div>' +
          '<label>תאריך לידה</label>' +
          '<input id="cfbyDob" type="date">' +
          '<button class="go" id="cfbyGo" disabled>המשך</button>' +
        '</div>';
      document.body.appendChild(ov);
      var gender = null;
      var gbtns = ov.querySelectorAll(".g");
      var dob = ov.querySelector("#cfbyDob");
      var go = ov.querySelector("#cfbyGo");
      function refresh() { go.disabled = !(gender && dob.value); }
      Array.prototype.forEach.call(gbtns, function (b) {
        b.onclick = function () {
          gender = b.getAttribute("data-g");
          Array.prototype.forEach.call(gbtns, function (x) { x.classList.remove("sel"); });
          b.classList.add("sel"); refresh();
        };
      });
      dob.oninput = refresh;
      go.onclick = function () {
        if (!gender || !dob.value) return;
        var out = { gender: gender, birth_date: dob.value };
        css.remove(); ov.remove();
        resolve(out);
      };
    });
  }

  // ---- block announcement: one-time popup + confetti -------------------
  // Pure CSS/JS confetti — no external lib (the app must work without CDNs).
  // The container ignores touches and removes itself when the show is over.
  function confettiBurst() {
    var host = document.createElement("div");
    host.style.cssText = "position:fixed;inset:0;z-index:100002;pointer-events:none;overflow:hidden";
    if (!document.getElementById("cfbyConfettiCss")) {
      var css = document.createElement("style");
      css.id = "cfbyConfettiCss";
      css.textContent =
        "@keyframes cfbyFall{0%{transform:translateY(-6vh) rotate(0deg)}100%{transform:translateY(106vh) rotate(720deg)}}";
      document.head.appendChild(css);
    }
    var colors = ["#ef5b25", "#23409a", "#e8a53a", "#2ecc71", "#3fa9bf", "#d8342b"];
    for (var i = 0; i < 90; i++) {
      var p = document.createElement("div");
      var emoji = i % 18 === 0;   // a few 🎖️/🎉 ride along with the paper bits
      var size = emoji ? 22 : (6 + Math.random() * 7);
      var dur = 2.4 + Math.random() * 2.2;
      p.style.cssText =
        "position:absolute;top:-6vh;left:" + (Math.random() * 100) + "vw;" +
        (emoji
          ? "font-size:" + size + "px;line-height:1;"
          : "width:" + size + "px;height:" + (size * 0.45) + "px;background:" + colors[i % colors.length] + ";" +
            "border-radius:" + (i % 3 === 0 ? "50%" : "2px") + ";") +
        "animation:cfbyFall " + dur + "s linear " + (Math.random() * 1.2) + "s both;will-change:transform";
      if (emoji) p.textContent = i % 36 === 0 ? "🎖️" : "🎉";
      host.appendChild(p);
    }
    document.body.appendChild(host);
    setTimeout(function () { host.remove(); }, 6000);
  }
  // Festive one-time popup. Built with textContent (never innerHTML on the
  // admin-authored text) so the message can't inject markup.
  function showAnnouncement(ann, onClose) {
    var ov = document.createElement("div");
    ov.id = "cfbyAnn";
    ov.style.cssText =
      "position:fixed;inset:0;z-index:100001;background:rgba(12,18,34,.62);backdrop-filter:blur(3px);" +
      "display:flex;align-items:center;justify-content:center;padding:20px;direction:rtl;font-family:'Heebo',system-ui,sans-serif";
    var box = document.createElement("div");
    box.style.cssText = "background:#fff;border-radius:22px;width:100%;max-width:420px;box-shadow:0 24px 70px rgba(12,18,34,.5);overflow:hidden;max-height:86vh;display:flex;flex-direction:column";
    var head = document.createElement("div");
    head.style.cssText = "background:linear-gradient(120deg,#141f38,#23409a);color:#fff;padding:26px 24px 22px;text-align:center";
    var medal = document.createElement("div");
    medal.style.cssText = "font-size:44px;line-height:1;margin-bottom:10px";
    medal.textContent = "🎖️";
    var h = document.createElement("div");
    h.style.cssText = "font-weight:800;font-size:20px;line-height:1.35";
    h.textContent = (ann && ann.title) || "בלוק חדש התחיל!";
    head.appendChild(medal); head.appendChild(h);
    var body = document.createElement("div");
    body.style.cssText = "padding:20px 24px;color:#1e2430;font-size:14.5px;line-height:1.7;white-space:pre-line;overflow:auto";
    body.textContent = (ann && ann.body) || "";
    var foot = document.createElement("div");
    foot.style.cssText = "padding:0 24px 22px";
    var go = document.createElement("button");
    go.style.cssText = "width:100%;background:#ef5b25;color:#fff;border:none;border-radius:12px;padding:14px;font:800 15px 'Heebo',sans-serif;cursor:pointer";
    go.textContent = "קדימה לבלוק! 💪";
    go.onclick = function () { ov.remove(); if (onClose) onClose(); };
    foot.appendChild(go);
    box.appendChild(head); box.appendChild(body); box.appendChild(foot);
    ov.appendChild(box);
    document.body.appendChild(ov);
    confettiBurst();
  }
  window.__cfbyAnnPreview = showAnnouncement;   // admin panel preview hook

  // ---- no-connection gate ----------------------------------------------
  // Shown only when the server is unreachable AND the device has no local copy
  // to boot from. Retries until the server answers — never boots "blind empty",
  // because an empty boot would later push an empty tracker over the cloud row.
  function netOverlay(show) {
    var el = document.getElementById("cfbyNet");
    if (!show) { if (el) el.remove(); return; }
    if (el || !document.body) return;
    el = document.createElement("div");
    el.id = "cfbyNet";
    el.style.cssText = "position:fixed;inset:0;z-index:100001;background:#0f1830;color:#eaf0ff;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;font:600 15px 'Heebo',system-ui,sans-serif;direction:rtl;text-align:center;padding:24px";
    el.innerHTML = '<div style="font-size:34px">📡</div><div>אין חיבור לשרת</div>' +
      '<div style="font-size:13px;color:#8ea3c9;font-weight:400">הנתונים שלך שמורים בענן — מתחבר שוב אוטומטית…</div>';
    document.body.appendChild(el);
  }
  window.__cfbyNet = netOverlay;
  async function waitForServer(uid) {
    netOverlay(true);
    for (var i = 1; ; i++) {
      await new Promise(function (r) { setTimeout(r, 3000); });
      // A live network but a dead token also lands here — nudge auth every ~15s.
      if (i % 5 === 0) { try { await sb.auth.refreshSession(); } catch (e) {} }
      var st = await fetchMyState(uid);
      if (!st.error) { netOverlay(false); return st; }
    }
  }

  // ---- local dev preview (no Supabase) ---------------------------------
  // http://localhost:PORT/app.html?dev=1 renders the app with demo data so
  // layout/CSS work doesn't require a real login. localhost-only — a hosted
  // deployment never enters this branch.
  async function devMain() {
    try { localStorage.setItem(K.WELCOME_KEY, "1"); } catch (e) {}
    try { localStorage.setItem("cfby_onb_v1", "1"); } catch (e) {}
    try { localStorage.setItem("cfby_reset_v1", "1"); } catch (e) {}
    localStorage.removeItem(K.TRACKER_KEY); // empty -> the app builds its built-in program
    lsSetRaw(K.BOARD_KEY, {
      board: [
        { id: "d1", name: "דנה כהן", weeks: [{ completed: 5, result: 0 }, { completed: 2, result: 0 }], metcons: {}, category: "elite women", age: 28,
          pub: { t: 12, s: 6, p: 4, rx: 3, r9: 2, fw: 1, prs: [
            { move: "Back Squat", res: "95kg × 1", week: "W2" },
            { move: "Fran", res: "4:12", week: "W2" },
            { move: "Deadlift", res: "120kg × 1", week: "W1" } ] } },
        { id: "d2", name: "יוסי לוי", weeks: [{ completed: 3, result: 0 }], metcons: {}, category: "elite men", age: 31,
          pub: { t: 3, s: 2, p: 0, rx: 1, r9: 0, fw: 0, prs: [] } },
        { id: "d3", name: "רון מזרחי", weeks: [{ completed: 4, result: 0 }], metcons: {}, category: "masters men", age: 42, pub: null }
      ],
      myName: "אורי (dev)", myResults: {}, myCategory: "elite men", myGender: "male", myAge: 30
    });
    window.cfbySignOut = function () { location.reload(); };
    window.cfbyIsAdmin = false;
    await loadScript("assets/js/html2canvas.js");
    await loadScript("assets/js/dc-runtime.js");
    await revealApp();
    versionTag();
  }

  // ---- main ------------------------------------------------------------
  async function main() {
    if (/^(localhost|127\.0\.0\.1)$/.test(location.hostname) &&
        new URLSearchParams(location.search).has("dev")) { return devMain(); }
    var ses = await sb.auth.getSession();
    var session = ses.data && ses.data.session;
    if (!session) { location.replace("index.html"); return; }
    var uid = session.user.id;
    accessToken = session.access_token || accessToken;   // keepalive pushes need it synchronously

    var prof = await fetchProfile(uid);
    var isAdmin = !!prof.is_admin;

    // First login: collect gender + birth date (needed for the competition
    // category). Blocks the app until answered, then refetches the profile.
    // Skipped when the profile FETCH failed — no signal did the user never
    // answer, and re-asking (then upserting over a good row) would be wrong.
    if (!prof._err && (!prof.gender || !prof.birth_date)) {
      try {
        var got = await askProfileDetails();
        await sb.from("profiles").upsert({ id: uid, gender: got.gender, birth_date: got.birth_date });
        prof.gender = got.gender; prof.birth_date = got.birth_date;
      } catch (e) { console.error("[onboarding]", e); }
    }

    // Nothing may pop up on its own. These flags are set BEFORE the app boots:
    //  - WELCOME_KEY : the guide opens only via the "❓ מדריך" button.
    //  - cfby_onb_v1 : the first-run onboarding is disabled outright (the display
    //                  name comes from the account/profile, so it has nothing to ask).
    //  - cfby_reset_v1: the app wipes all logs on its first run unless this is set.
    //                  Our logs come from Supabase, so that would destroy synced
    //                  progress. Never let it run.
    try { localStorage.setItem(K.WELCOME_KEY, "1"); } catch (e) {}
    try { localStorage.setItem("cfby_onb_v1", "1"); } catch (e) {}
    try { localStorage.setItem("cfby_reset_v1", "1"); } catch (e) {}

    // 1) seed the tracker. The app reconciles shape + program version itself.
    // If this device holds tracker changes that never reached Supabase (dirty
    // stamp newer than the server row), the local copy wins and is pushed up —
    // otherwise a push lost to the mobile lifecycle would be erased here by the
    // stale server copy, which is exactly the "my workout disappeared" bug.
    var localTracker = lsGet(K.TRACKER_KEY);
    var st = await fetchMyState(uid);
    if (st.error && !(localTracker && localTracker.weeks)) {
      // Server unreachable and nothing local to boot from — wait, don't guess.
      st = await waitForServer(uid);
    }
    var mine = st.row;
    var dirtyTs = parseInt(rawGet(DIRTY_KEY), 10) || 0;
    var keepLocal = false;
    if (st.error) {
      // Server unreachable but the device has a copy: boot from it, touch
      // NOTHING. Only data that was already marked unsynced gets pushed once
      // the connection returns. (This failure used to fall into the "fresh
      // user" branch below — wiping the device and then overwriting the cloud
      // row with an empty scaffold. That was the repeating data loss.)
      keepLocal = dirtyTs > 0;
      syncShow(navigator.onLine === false ? "offline" : "error");
    } else if (mine && mine.tracker && mine.tracker.weeks) {
      var serverTs = mine.updated_at ? Date.parse(mine.updated_at) || 0 : 0;
      if (localTracker && localTracker.weeks && dirtyTs > serverTs) {
        keepLocal = true;                       // unsynced local changes are newer
      } else {
        lsSetRaw(K.TRACKER_KEY, mine.tracker);  // this user's own saved blob
        try { localStorage.removeItem(DIRTY_KEY); } catch (e) {}
      }
    } else {
      // The server ANSWERED and there is no row: confirmed fresh user, or an
      // admin wiped this account's data. The server wins outright — clear any
      // stale local copy so deleted data can never resurrect from a device,
      // then seed the published program (scaffold only, stripped of any logs
      // an older buggy publish may have left in shared_program).
      try { localStorage.removeItem(K.TRACKER_KEY); localStorage.removeItem(DIRTY_KEY); } catch (e) {}
      var prog = await fetchSharedProgram();    // fresh user -> admin's published program
      if (prog) lsSetRaw(K.TRACKER_KEY, { v: 2, weeks: stripLogs(prog) });
      // else: leave empty -> the app builds its built-in program
    }

    // 2) board (shared leaderboard). Built from the full roster of registered
    //    athletes (profiles), so a new user shows up immediately — not only once
    //    they log a workout. Their board row (completed counts + result) is
    //    merged in when it exists. Everyone competes, admins included; "you" is
    //    rendered by the app separately, so exclude only self here.
    var fb = await fetchBoard();
    var byId = {};
    fb.rows.forEach(function (r) { byId[r.user_id] = r; });
    var profiles = await fetchAllProfiles();
    var board = profiles
      .filter(function (p) { return p.id !== uid; })
      .map(function (p) {
        var r = byId[p.id];
        return { id: p.id, name: (r && r.name) || p.name || "", weeks: (r && r.weeks) || [],
                 metcons: (r && r.metcons) || {}, category: categoryOf(p.gender, p.birth_date),
                 age: ageFrom(p.birth_date), pub: (r && r.pub) || null };
      });
    var myRow = byId[uid];
    // If the board fetch failed, my own fields fall back to the previous local
    // copy — otherwise a flaky load would blank myResults and the next push
    // would erase the weekly results on the server too.
    var prevB = lsGet(K.BOARD_KEY) || {};
    lsSetRaw(K.BOARD_KEY, {
      board: (fb.error && Array.isArray(prevB.board) && prevB.board.length) ? prevB.board : board,
      myName: (myRow && myRow.name) || (fb.error && prevB.myName) || prof.name || (session.user.email || "").split("@")[0],
      myResults: (myRow && myRow.results) || (fb.error && prevB.myResults) || {},
      myCategory: categoryOf(prof.gender, prof.birth_date),
      myGender: prof.gender || null,
      myAge: ageFrom(prof.birth_date)
    });

    // 3) intercept future writes
    installInterceptor(uid, isAdmin);

    // Local tracker was newer than the server (a push was lost) — sync it up now.
    if (keepLocal) pushState();

    // One-time board sync on load: seeding above happens BEFORE the interceptor,
    // so a user who already completed workouts (in their state) wouldn't be on
    // the board until their next change. Push now so they appear immediately —
    // but never after a failed board fetch (we'd be pushing fallback data).
    if (!fb.error) pushBoard();

    // expose a manual sign-out for the app if needed
    window.cfbySignOut = async function () { await sb.auth.signOut(); location.replace("index.html"); };
    window.cfbyIsAdmin = isAdmin;

    // 4) NOW boot the app (data is already in localStorage)
    await loadScript("assets/js/html2canvas.js");
    await loadScript("assets/js/dc-runtime.js");
    await revealApp();
    versionTag();
    checkFreshBundle();   // fire-and-forget: reloads only if a newer build is live

    // Block announcement: pops ONCE per user, and only when the admin has
    // published one whose id this user hasn't seen. No announcement row (the
    // state today) -> nothing pops for anyone. Skipped when the profile fetch
    // failed: without the seen-marker we'd re-show on every flaky load.
    if (!prof._err) {
      fetchAnnouncement().then(function (ann) {
        if (!ann || !ann.id) return;
        if (prof.announcement_seen === ann.id) return;
        if (rawGet("cfby_ann_seen") === ann.id) return;   // device fallback if the upsert below failed
        showAnnouncement(ann, function () {
          try { localStorage.setItem("cfby_ann_seen", ann.id); } catch (e) {}
          sb.from("profiles").upsert({ id: uid, announcement_seen: ann.id })
            .then(function () {}, function () {});
        });
      }).catch(function () {});
    }

    // 5) admins get the in-app user-management panel (floating button)
    if (isAdmin) { try { injectAdminPanel(uid); } catch (e) { console.error("[admin panel]", e); } }

    // 6) live leaderboard: refresh others' rows whenever the board changes
    subscribeBoard(uid);
  }

  // app.html hides <x-dc> because the browser paints that raw markup — modals and
  // all — before the runtime replaces it. Unrendered "{{ binding }}" text is the
  // tell that it has not rendered yet; once it is gone, mark the page ready.
  //
  // Only flip a class on <html> — never touch the nodes. The runtime rebuilds
  // <body> into its own #dc-root, which reverts inline styles and re-creates
  // removed nodes; a class on <html> survives that, and app.html's CSS does the
  // rest. Re-query every tick for the same reason. Marks ready regardless after
  // ~3s so a runtime change can never strand the user on a blank page.
  function revealApp() {
    return new Promise(function (res) {
      var tries = 0;
      (function poll() {
        // The runtime renders into a fresh #dc-root and removes <x-dc>. Treat
        // #dc-root appearing as "rendered"; also accept an <x-dc> whose bindings
        // are gone, in case the runtime's root id ever changes. ~3s hard cap.
        var x = document.querySelector("x-dc");
        var rendered = !!document.getElementById("dc-root") ||
                       (x && x.innerHTML.length > 0 && x.innerHTML.indexOf("{{") === -1);
        if (rendered || ++tries > 100) {
          document.documentElement.classList.add("cfby-ready");
          return res();
        }
        setTimeout(poll, 30);
      })();
    });
  }

  main().catch(function (e) {
    console.error("[boot] fatal", e);
    document.body.insertAdjacentHTML("beforeend",
      '<div style="position:fixed;inset:auto 12px 12px 12px;background:#2a1215;color:#ff8a80;' +
      'font:13px/1.5 monospace;padding:12px;border-radius:8px;z-index:99999">' +
      '[boot] ' + (e && e.message || e) + '</div>');
  });
})();
