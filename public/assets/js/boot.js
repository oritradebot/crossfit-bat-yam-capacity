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
  var BUILD = "2.2.2";
  var K = window.CFBY;
  var sb = window.supabase.createClient(window.SUPA_URL, window.SUPA_ANON_KEY);
  window.__sb = sb;

  // ---- theme (light / dark / auto) --------------------------------------
  // Stored per-device on purpose (NOT in the synced state blob) — moving it
  // into the blob later makes it roam between devices with no schema change.
  // Runs here, in <head>, so <html> carries data-theme before first paint.
  var THEME_KEY = "cfby_theme";
  function themePref() {
    var p = null;
    try { p = localStorage.getItem(THEME_KEY); } catch (e) {}
    return (p === "light" || p === "dark") ? p : "auto";
  }
  function applyTheme() {
    var pref = themePref();
    var mq = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)");
    var dark = pref === "dark" || (pref === "auto" && mq && mq.matches);
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
    // The app header is a navy gradient in BOTH themes, so the status-bar
    // color only needs to change on pages without it (login / confirm).
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta && meta.getAttribute("data-follow-theme") === "1") {
      meta.setAttribute("content", dark ? "#0d0e11" : "#0f1830");
    }
  }
  window.cfbyThemePref = themePref;
  window.cfbySetTheme = function (mode) {
    try {
      if (mode === "light" || mode === "dark") localStorage.setItem(THEME_KEY, mode);
      else localStorage.removeItem(THEME_KEY);
    } catch (e) {}
    applyTheme();
  };
  applyTheme();
  if (window.matchMedia) {
    var mql = window.matchMedia("(prefers-color-scheme: dark)");
    var onOs = function () { if (themePref() === "auto") applyTheme(); };
    if (mql.addEventListener) mql.addEventListener("change", onOs);
    else if (mql.addListener) mql.addListener(onOs);
  }

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
      // Transitional: until the v1.6.0 ALTERs run in the SQL editor, the pub
      // column doesn't exist and the select 42703s — retry without it so the
      // leaderboard never breaks on a schema lag.
      if (r.error && /\bpub\b/.test(r.error.message || ""))
        r = await sb.from("board").select("user_id,name,results,weeks,metcons").order("name");
      return { rows: r.data || [], error: r.error || null };
    } catch (e) { return { rows: [], error: e }; }
  }
  async function fetchProfile(uid) {
    try {
      var r = await sb.from("profiles").select("name,is_admin,welcome_seen,gender,birth_date,announcement_seen").eq("id", uid).maybeSingle();
      // Transitional: schema not migrated yet — retry without the new column
      // (a profile-fetch failure here would wrongly skip onboarding + popup).
      if (r.error && /announcement_seen/.test(r.error.message || ""))
        r = await sb.from("profiles").select("name,is_admin,welcome_seen,gender,birth_date").eq("id", uid).maybeSingle();
      if (r.error) throw r.error;
      return r.data || { name: "", is_admin: false, welcome_seen: false, gender: null, birth_date: null, announcement_seen: null };
    } catch (e) {
      return { name: "", is_admin: false, welcome_seen: false, gender: null, birth_date: null, announcement_seen: null, _err: true };
    }
  }
  // The block announcement the admin published (or null), plus the block-recap
  // gate flag, in ONE query. Fetched separately from the program: it is read on
  // EVERY boot, while the program row's weeks blob is only pulled for fresh
  // users. The block_recap column may not exist yet (schema.sql not run) —
  // fall back to the announcement-only select, same convention as the
  // announcement_log tolerance in the admin panel. A missing/failed flag is
  // simply null, which the gate reads as closed. A gate that fails open is
  // not a gate.
  async function fetchAnnouncement() {
    try {
      var r = await sb.from("shared_program").select("announcement,block_recap").eq("id", 1).maybeSingle();
      if (r.error && /block_recap/.test(r.error.message || "") && /column|schema/i.test(r.error.message || "")) {
        var r2 = await sb.from("shared_program").select("announcement").eq("id", 1).maybeSingle();
        return { announcement: (r2.data && r2.data.announcement) || null, block_recap: null };
      }
      return { announcement: (r.data && r.data.announcement) || null,
               block_recap: (r.data && r.data.block_recap) || null };
    } catch (e) { return { announcement: null, block_recap: null }; }
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

  // ---- day-level merge (v1.7.0) ----------------------------------------
  // The sync model used to be "last whole notebook wins": every push replaced
  // the entire tracker, so ANY two storage contexts (phone + computer, or on
  // iOS even Safari + the home-screen app — separate storages!) silently erased
  // each other's workouts. Now every day carries a "last touched" stamp
  // (DTS_KEY, keyed "week_day"), the stamps ride inside the states blob as
  // tracker._dts (no schema change), and boot MERGES local+server per day —
  // each day survives from whichever side touched it last.
  var DTS_KEY = "cfby_dts_v1";

  // JSON.stringify with sorted keys. Postgres jsonb does NOT preserve key
  // order, so a naive stringify of the same log round-tripped through the
  // server would differ — and every boot would look like a change to push.
  function stable(o) {
    if (o === null || typeof o !== "object") return JSON.stringify(o);
    if (Array.isArray(o)) return "[" + o.map(stable).join(",") + "]";
    return "{" + Object.keys(o).sort().map(function (k) { return JSON.stringify(k) + ":" + stable(o[k]); }).join(",") + "}";
  }
  // A log object holding only empty fields counts as NO log — the app
  // initializes empty {weight:'',time:''...} shells on days it touches, and a
  // shell must compare equal to a stripped/absent log, or an app-initialized
  // empty day could outrank a day someone actually logged.
  function cleanLog(L) {
    if (!L || typeof L !== "object") return L || null;
    var out = {}, has = false;
    for (var k in L) {
      if (k === "mode") continue;               // mode alone (default UI state) isn't data
      var v = L[k];
      if (v === "" || v == null || v === false) continue;
      out[k] = v; has = true;
    }
    if (!has) return null;
    if (L.mode) out.mode = L.mode;              // but with real values, mode matters (scoring)
    return out;
  }
  // Signature of a day's USER LOG only — plan text is deliberately excluded,
  // so program edits by the admin never look like log changes on athletes'
  // days (the app re-overlays plan text via applyProgram/pv anyway).
  function logSig(d) {
    if (!d) return "";
    function m(x) {
      if (!x) return null;
      var l = cleanLog(x.log);
      return (x.rx || x.scaled || l) ? [!!x.rx, !!x.scaled, l] : null;
    }
    var core = {
      done: !!d.done, rest: !!d.rest, rating: d.rating || "", summary: d.summary || "", pr: !!d.pr,
      lift: cleanLog(d.lift && d.lift.log),
      mc: m(d.metcon), mc2: m(d.metcon2),
      ex: Array.isArray(d.extras) ? d.extras.map(function (x) {
        if (!x) return null;
        var l = cleanLog(x.log);
        return (x.result || l) ? [x.result || "", l] : null;
      }) : null
    };
    if (d.alt) core.alt = logSig(d.alt);
    return stable(core);
  }
  // Called on every tracker write: stamp "now" on each day whose log changed.
  function stampChangedDays(prevRaw, newRaw) {
    var prev = null, next = null;
    try { prev = JSON.parse(prevRaw); } catch (e) {}
    try { next = JSON.parse(newRaw); } catch (e) {}
    var nw = (next && next.weeks) || [], pw = (prev && prev.weeks) || [];
    var dts = dtsGet(), changed = false, now = Date.now(), keys = [];
    for (var w = 0; w < nw.length; w++) {
      var nd = (nw[w] && nw[w].days) || [], pd = (pw[w] && pw[w].days) || [];
      for (var d = 0; d < nd.length; d++) {
        var sNew = logSig(nd[d]);
        if (pd[d] === undefined) {
          // Day appeared (first write on this device / program grew): stamp it
          // only if it already carries logs — a blank scaffold day must never
          // win a merge against a day someone actually logged.
          var blank;
          try { blank = logSig(stripDayLogs(JSON.parse(JSON.stringify(nd[d])))); } catch (e) { blank = ""; }
          if (sNew !== blank) { dts[w + "_" + d] = now; changed = true; keys.push(w + "_" + d); }
        } else if (sNew !== logSig(pd[d])) {
          dts[w + "_" + d] = now; changed = true; keys.push(w + "_" + d);
        }
      }
    }
    if (changed) { memDts = dts; try { lsSetRaw(DTS_KEY, dts); } catch (e) {} }
    return keys;
  }
  // Merge two tracker copies day by day. preferLocal breaks ties for days with
  // equal (usually missing/legacy) stamps — callers pass the old whole-blob
  // rule (device dirty-stamp newer than the server row), so pre-1.7.0 data
  // behaves exactly as before until stamps accumulate.
  // Returns localWon=true when the merged result carries anything the server
  // copy doesn't — i.e. it must be pushed up.
  function mergeTrackers(localT, localDts, serverT, serverDts, preferLocal) {
    var lw = (localT && localT.weeks) || [], sw = (serverT && serverT.weeks) || [];
    var weeks = [], dts = {}, localWon = false;
    var W = Math.max(lw.length, sw.length);
    for (var w = 0; w < W; w++) {
      var base = JSON.parse(JSON.stringify(sw[w] || lw[w]));
      var ld = (lw[w] && lw[w].days) || [], sd = (sw[w] && sw[w].days) || [];
      var D = Math.max(ld.length, sd.length), days = [];
      for (var d = 0; d < D; d++) {
        var k = w + "_" + d;
        var lts = localDts[k] || 0, sts = serverDts[k] || 0;
        var pick;
        if (ld[d] === undefined) pick = "s";
        else if (sd[d] === undefined) pick = "l";
        else if (lts !== sts) pick = lts > sts ? "l" : "s";
        else pick = preferLocal ? "l" : "s";
        days.push(pick === "l" ? ld[d] : sd[d]);
        if (pick === "l" && (sd[d] === undefined || logSig(ld[d]) !== logSig(sd[d]))) localWon = true;
        var mx = Math.max(lts, sts);
        if (mx > 0) dts[k] = mx;   // never-touched days carry no stamp (keeps the map lean)
      }
      base.days = days;
      weeks.push(base);
    }
    return {
      tracker: { v: 2, pv: Math.max((localT && localT.pv) || 0, (serverT && serverT.pv) || 0), weeks: weeks },
      dts: dts,
      localWon: localWon
    };
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
  // Why the last close-time keepalive push failed, read back on the next open.
  // The page is dying when that push fires, so there is no one to show a badge
  // to — this is the only way the failure can ever reach the user.
  // Values: "size" (body over the cap), "auth", "neterr", "norpc" (push_days
  // not installed on the DB yet), "rpc<status>", or an HTTP status.
  var KA_KEY = "cfby_ka_fail_v1";
  // Browsers reject a keepalive request whose total body exceeds 64KB. Stay
  // under it with margin for headers.
  var KEEPALIVE_MAX = 60000;
  function rawGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }

  // In-memory mirrors of the tracker, day stamps, and dirty flag (v1.7.1).
  // localStorage on iOS can start failing silently mid-session (quota /
  // restricted mode) — and every push used to RE-READ storage, so a dead
  // storage meant nothing reached the cloud while the UI kept saying "saved".
  // That was the 27/07 bug: a logged workout lived only in React state, the
  // pushes carried the stale persisted copy, and the next reload reverted the
  // day. Pushes now read these mirrors first; storage is just the cache.
  var memTracker = null;   // last tracker JSON string (boot seed / app write)
  var memBoard = null;     // last board JSON string the USER wrote (not realtime refreshes)
  var memDts = null;       // per-day stamp map (see DTS_KEY)
  var memDirty = false;    // true while a write is not yet confirmed pushed
  var memSeq = 0;          // bumps on every tracker write (push-race token)
  // Day keys ("w_d") written since the last confirmed FULL states push — the
  // close-time RPC's payload (v1.7.3). A handful of days is ~2KB and always
  // fits under the 64KB keepalive cap that the full blob outgrew; and because
  // it lives in memory, it survives a dead localStorage just like memTracker.
  var memDirtyDays = {};
  // DIRTY_KEY can get STUCK when storage stops accepting writes: the push
  // succeeds but removeItem fails, and the stale stamp would block self-update
  // forever and re-push every 15s. dirtyStuck marks that state (set only when
  // a push confirmed everything current is up) so the stamp stops counting.
  var dirtyStuck = false;
  function unsynced() { return memDirty || (!dirtyStuck && rawGet(DIRTY_KEY) !== null); }
  function dtsGet() { return memDts || lsGet(DTS_KEY) || {}; }

  // ---- sync status badge ------------------------------------------------
  // The user must SEE sync state — silent failures are exactly how workouts
  // got lost before. One small pill, bottom-left, never intercepts touches.
  var syncHideT = null;
  var lastLocalFailAt = 0;
  // The pill is held by REFERENCE and re-appended by versionTag's observer:
  // the runtime rebuilds <body> on every render (a save triggers several —
  // toast in/out, the day flipping to ✓), and each rebuild threw the pill out
  // of the DOM at the exact moment it was showing. On phones the user then
  // locks the screen and never catches it alive — "there is no badge" (01/08).
  var pillEl = null;
  // Last sync state, re-painted onto the footer line (which survives rebuilds)
  // so the cloud state is ALWAYS readable, not a 3-second pill.
  var lastCloud = { kind: null, at: 0 };
  // A dead session (revoked or expired refresh token) used to produce an
  // endless red "retrying" badge with no way out. We never auto-redirect:
  // location.replace() destroys memTracker, which is the ONLY copy of a
  // just-logged workout when device storage is silently dead. Re-login is an
  // explicit tap, and it refuses to leave unsynced work behind without asking.
  var sessionDead = false, signingOut = false;
  async function reauthTap() {
    if (unsynced()) {
      syncShow("saving");
      try { await doPushState(); } catch (e) {}
      if (unsynced() &&
          !confirm("יש אימון שעדיין לא נשמר בענן — התחברות מחדש עלולה לאבד אותו.\n\nלהתחבר מחדש בכל זאת?")) {
        syncShow("reauth");
        return;
      }
    }
    location.replace("index.html");
  }
  function syncShow(kind) {
    if (!document.body) return;
    // A device-storage failure must stay on screen long enough to be read —
    // the scheduled push showed "saving…"/"saved" within a second and wiped
    // the warning before anyone saw it.
    if ((kind === "saving" || kind === "saved") && Date.now() - lastLocalFailAt < 5000) return;
    if (kind === "localfail") lastLocalFailAt = Date.now();
    var el = pillEl;
    if (!el) {
      el = document.createElement("div");
      el.id = "cfbySync";
      // In a browser tab (not the installed PWA) Safari's bottom URL bar
      // OVERLAYS the page bottom — a 10px-offset pill is invisible exactly
      // when it matters (the 27/07 lost-workout video: the storage-failure
      // alert was showing, hidden behind the toolbar). In the installed PWA
      // there is no toolbar, but the app's own toast pops at bottom:24px —
      // 72px clears that band too.
      var standalone = false;
      try { standalone = (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) || window.navigator.standalone === true; } catch (e) {}
      el.style.cssText =
        "position:fixed;left:10px;bottom:calc(" + (standalone ? "72px" : "88px") + " + env(safe-area-inset-bottom,0px));z-index:99990;" +
        "color:#fff;font:600 12px 'Heebo',system-ui,sans-serif;padding:6px 12px;border-radius:20px;direction:rtl;" +
        "box-shadow:0 4px 14px rgba(0,0,0,.25);pointer-events:none;transition:opacity .25s;opacity:0";
      pillEl = el;
    }
    // The runtime may have rebuilt <body> since the last show and orphaned the
    // pill — re-append by reference (state intact). versionTag's observer does
    // the same between shows.
    if (!el.parentNode) document.body.appendChild(el);
    clearTimeout(syncHideT);
    if (kind === "saving")       { el.textContent = "⏳ שומר…";                        el.style.background = "#233657"; }
    else if (kind === "saved")   { el.textContent = "✓ נשמר בענן";                    el.style.background = "#1e7e46"; }
    else if (kind === "error")   { el.textContent = "⚠️ לא מסונכרן — מנסה שוב";       el.style.background = "#a33b2e"; }
    else if (kind === "offline") { el.textContent = "📡 אין אינטרנט — יסונכרן כשיחזור"; el.style.background = "#8a6d1a"; }
    else if (kind === "localfail") { el.textContent = "⚠️ השמירה במכשיר נכשלה — האחסון מלא?"; el.style.background = "#a33b2e"; }
    else if (kind === "reauth")  { el.textContent = "🔑 ההתחברות פגה — הקישו כדי להתחבר מחדש"; el.style.background = "#7a3ea8"; }
    else if (kind === "pubfail") { el.textContent = "⚠️ האימון נשמר, אך פרסום התוכנית נכשל"; el.style.background = "#a3702e"; }
    // The pill is normally inert so it can never swallow a tap meant for the
    // app. The reauth state is the ONE exception: it is the user's only way
    // out of a dead session, so it must be tappable.
    el.style.pointerEvents = (kind === "reauth") ? "auto" : "none";
    el.style.cursor = (kind === "reauth") ? "pointer" : "";
    el.onclick = (kind === "reauth") ? reauthTap : null;
    el.style.opacity = "1";
    if (kind === "saved") syncHideT = setTimeout(function () { el.style.opacity = "0"; }, 3000);
    // Mirror every state onto the footer line — the pill is transient and can
    // be missed; the footer answer to "did it reach the cloud?" is permanent.
    lastCloud = { kind: kind, at: Date.now() };
    cloudPaint();
  }
  window.__cfbySync = syncShow;
  // Permanent cloud-state line inside the version footer. This replaces the
  // exported app's static "הנתונים נשמרים אוטומטית במכשיר הזה" claim as the
  // thing users actually read at the page bottom (01/08: Ori read that line,
  // believed sync was device-only, and had never once caught the pill alive).
  function cloudPaint() {
    var el = document.getElementById("cfbyCloud");
    if (!el) return;
    var k = lastCloud.kind;
    var t = lastCloud.at ? new Date(lastCloud.at) : null;
    var hm = t ? ("0" + t.getHours()).slice(-2) + ":" + ("0" + t.getMinutes()).slice(-2) : "";
    var txt, color = "", tap = false;
    if (k === "saved")         { txt = "☁️ מסונכרן לענן · " + hm; color = "#1e7e46"; }
    else if (k === "saving")   { txt = "☁️ שומר בענן…"; }
    else if (k === "error")    { txt = "⚠️ לא מסונכרן — מנסה שוב"; color = "#a33b2e"; }
    else if (k === "offline")  { txt = "📡 אין אינטרנט — יסונכרן כשיחזור"; color = "#8a6d1a"; }
    else if (k === "reauth")   { txt = "🔑 ההתחברות פגה — הקישו כאן"; color = "#7a3ea8"; tap = true; }
    else if (k === "localfail"){ txt = "⚠️ בעיית אחסון במכשיר — הענן הוא הגיבוי"; color = "#a33b2e"; }
    else if (k === "pubfail")  { txt = "⚠️ נשמר; פרסום התוכנית נכשל"; color = "#a3702e"; }
    else                       { txt = pushCtx.uid ? "☁️ מסונכרן לענן" : ""; }
    el.textContent = txt;
    el.style.color = color;
    el.style.fontWeight = k && k !== "saved" ? "700" : "500";
    el.style.pointerEvents = tap ? "auto" : "none";
    el.style.cursor = tap ? "pointer" : "";
    el.onclick = tap ? reauthTap : null;
  }

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
      if (unsynced()) return;
      if (rawGet("cfby_upd_v1") === j.build) return;
      try { localStorage.setItem("cfby_upd_v1", j.build); } catch (e) {}
      location.reload();
    } catch (e) {}
  }
  // Cross-device freshness (v1.7.4): the tracker used to be reconciled at BOOT
  // only, so a workout pushed from the phone reached an already-open computer
  // only after a manual refresh — which reads as "it didn't save" (01/08).
  // On every return to a CLEAN page, ask the server for the states row's
  // updated_at ALONE (a few bytes — never the blob) and reload when another
  // device has pushed since; boot's day-merge then brings the data in. Only
  // ever over a clean page: a dirty page is busy pushing its own data, and
  // the server must never win mid-session over unsynced local work.
  var freshBusy = false, lastFreshAt = 0;
  async function checkCloudFresh() {
    if (freshBusy || pushBusy || !pushCtx.uid || !lastServerStamp) return;
    if (unsynced() || sessionDead || navigator.onLine === false) return;
    if (Date.now() - lastFreshAt < 30000) return;
    freshBusy = true;
    try {
      var r = await sb.from("states").select("updated_at").eq("user_id", pushCtx.uid).maybeSingle();
      lastFreshAt = Date.now();
      // Errors and "no row" prove NOTHING (a dead session reads as empty under
      // RLS) — reload only on a positively newer server stamp, and only if the
      // page is still clean after the await.
      if (!r.error && r.data && r.data.updated_at &&
          Date.parse(r.data.updated_at) - Date.parse(lastServerStamp) > 1500 &&
          !unsynced() && !pushBusy) {
        location.reload();
      }
    } catch (e) {} finally { freshBusy = false; }
  }
  // Build tag so "which code is my phone actually running?" is answerable with
  // one glance. A static footer at the very bottom of the page (per Ori) — the
  // old fixed corner tag was black-on-transparent, i.e. invisible in dark mode.
  // The runtime rebuilds <body> into #dc-root on renders, which throws the
  // footer out — the observer puts it back so it survives every re-render.
  function versionTag() {
    if (!document.body) return;
    function ensure() {
      // The pill rides the same rescue: a body rebuild orphans it mid-display.
      if (pillEl && !pillEl.parentNode) document.body.appendChild(pillEl);
      if (document.getElementById("cfbyVer")) return;
      var el = document.createElement("div");
      el.id = "cfbyVer";
      el.style.cssText = "text-align:center;direction:rtl;" +
        "padding:14px 0 calc(18px + env(safe-area-inset-bottom,0px));" +
        "font:500 11px 'Heebo',system-ui,sans-serif;color:var(--muted,#8a8d94)";
      var cloud = document.createElement("span");
      cloud.id = "cfbyCloud";
      var sep = document.createElement("span");
      sep.textContent = " · ";
      var ver = document.createElement("span");
      ver.textContent = "גרסה " + BUILD;
      el.appendChild(cloud); el.appendChild(sep); el.appendChild(ver);
      document.body.appendChild(el);
      cloudPaint();
    }
    ensure();
    new MutationObserver(ensure).observe(document.body, { childList: true });
  }

  // A freshly deployed service worker pings every open page (see sw.js).
  // Answering marks this page as self-updating — it refreshes politely via
  // checkFreshBundle, never over unsynced data. Pages running builds older
  // than this listener can't answer, and the SW force-reloads them: the only
  // channel that reaches installed PWAs stuck on old bundles for days.
  //
  // Answer through BOTH routes: on a page that loaded uncontrolled (first
  // visit in this storage context), the ping can arrive before clients.claim()
  // propagates — controller is still null, the answer is silently skipped, and
  // the SW force-reloads a perfectly current page. That forced reload is what
  // exposed the 27/07 lost-workout bug mid-session.
  function answerAlive() {
    try {
      if (navigator.serviceWorker.controller) navigator.serviceWorker.controller.postMessage("cfby-alive");
    } catch (e) {}
    try {
      navigator.serviceWorker.getRegistration().then(function (r) {
        var w = r && (r.active || r.waiting || r.installing);
        if (w) w.postMessage("cfby-alive");
      }).catch(function () {});
    } catch (e) {}
  }
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", function (ev) {
      if (!ev || ev.data !== "cfby-sw-updated") return;
      answerAlive();
      checkFreshBundle();
    });
    // A takeover (claim) means a new SW just activated — its rescue timer may
    // already be running. Announce ourselves the moment it becomes reachable.
    navigator.serviceWorker.addEventListener("controllerchange", function () { answerAlive(); });
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
  // ISO stamp of the newest server states row this page knows about — set at
  // boot and after every confirmed full push. checkCloudFresh compares the
  // live row against it to spot pushes made by OTHER devices meanwhile.
  var lastServerStamp = null;

  // Serialized: one states push in flight at a time. Two concurrent pushes
  // (a slow retry racing a fresh save) are last-write-wins on the server —
  // the OLDER payload can land second and clobber the newer one.
  var pushBusy = false, pushQueued = false, pushStartedAt = 0;
  async function doPushState() {
    if (!pushCtx.uid) return;
    if (pushBusy) { pushQueued = true; return; }
    // The memory mirror is the source of truth — storage is only the fallback
    // for the first push after boot. A dead localStorage must never stop (or
    // stale-ify) the cloud push; that silently lost workouts (27/07).
    var traw = memTracker !== null ? memTracker : rawGet(K.TRACKER_KEY);
    if (!traw) return;
    var tracker;
    try { tracker = JSON.parse(traw); } catch (e) { return; }
    if (!tracker) return;
    var stamp = rawGet(DIRTY_KEY);
    var seqAtStart = memSeq;
    if (stamp !== null || memDirty) syncShow("saving");
    // The per-day stamps ride inside the blob (tracker._dts) so other devices
    // can merge day-by-day; boot strips the field before the app sees it.
    // SNAPSHOT the stamp map — dtsGet() returns the live memDts, which
    // stampChangedDays mutates on every write. upsertWithRetry re-serializes
    // the row on its JWT-refresh retry, and a write landing in that window
    // would ship OLD day data under a NEW stamp — a stamp that then beats the
    // real data in merges.
    var payload = Object.assign({}, tracker, { _dts: Object.assign({}, dtsGet()) });
    pushBusy = true;
    pushStartedAt = Date.now();
    var r;
    var nowIso = new Date().toISOString();
    try { r = await upsertWithRetry("states", { user_id: pushCtx.uid, tracker: payload, updated_at: nowIso }); }
    finally { pushBusy = false; }
    if (pushQueued) { pushQueued = false; setTimeout(doPushState, 0); }
    if (r.error) {
      console.error("[sync] states push failed:", r.error.message || r.error);
      // upsertWithRetry already refreshed the session once and retried. If it
      // STILL reads as an auth failure while the network is up, the session is
      // genuinely dead — an endless red "retrying" badge would never resolve.
      // Say so instead, but never block the write and never navigate.
      var em = String((r.error && (r.error.message || r.error.code)) || "");
      if (navigator.onLine !== false &&
          (r.error.code === "PGRST301" || r.error.status === 401 ||
           /jwt|token|unauthorized|not authenticated/i.test(em))) sessionDead = true;
      syncShow(navigator.onLine === false ? "offline" : (sessionDead ? "reauth" : "error"));
      clearTimeout(retryT);
      // Keep retrying underneath either way — a session that heals on its own
      // re-syncs with no user action — just back off against an auth wall.
      retryT = setTimeout(doPushState, sessionDead ? 60000 : 10000);
      return;
    }
    sessionDead = false;   // a clean push proves the session is alive
    lastServerStamp = nowIso;   // the server row now carries exactly this stamp
    // Admin also publishes the program scaffold for everyone — STRIPPED of the
    // admin's own logs (see stripLogs above). This used to run AFTER the badge
    // already said "saved", with its result never inspected: the admin saw
    // "✓ נשמר בענן" while the program push to every athlete had failed.
    // Publish FIRST, and let its outcome decide the badge.
    var pubErr = null;
    if (pushCtx.isAdmin && tracker.weeks) {
      var pr = await upsertWithRetry("shared_program", { id: 1, weeks: stripLogs(tracker.weeks), updated_at: new Date().toISOString() });
      if (pr.error) { pubErr = pr.error; console.error("[sync] shared_program publish failed:", pr.error.message || pr.error); }
    }
    // Clear the dirty markers only if nothing was written while the push was
    // in flight — a newer write must stay marked as unsynced.
    if (memSeq === seqAtStart) {
      var showSaved = memDirty || stamp !== null;
      memDirty = false;
      memDirtyDays = {};   // the full blob covered every day — nothing pending for the close-time RPC
      if (stamp !== null && rawGet(DIRTY_KEY) === stamp) {
        try { localStorage.removeItem(DIRTY_KEY); } catch (e) {}
      }
      // No new writes happened, so a DIRTY stamp that survived the clear above
      // is storage refusing writes — stop letting it block self-update or
      // trigger the 15s re-push loop (memDirty covers real unsynced data).
      dirtyStuck = rawGet(DIRTY_KEY) !== null;
      // The athlete's OWN data did land — only the program publish failed, so
      // say exactly that rather than a generic sync error.
      if (pubErr) syncShow("pubfail");
      else if (showSaved) syncShow("saved");
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
    // Memory mirrors first — same dead-storage rule as doPushState: the board
    // row (completed counts, metcon results, weekly results) must be derived
    // from what the user actually did this session, not the last persisted copy.
    var b = null;
    if (memBoard !== null) { try { b = JSON.parse(memBoard); } catch (e) {} }
    if (!b) b = lsGet(K.BOARD_KEY) || {};
    var tracker = null;
    if (memTracker !== null) { try { tracker = JSON.parse(memTracker); } catch (e) {} }
    if (!tracker) tracker = lsGet(K.TRACKER_KEY);
    var row = {
      user_id: pushCtx.uid,
      name: b.myName || "",
      results: b.myResults || {},
      weeks: summarizeWeeks(tracker, b.myResults),
      metcons: extractMetcons(tracker),
      pub: publicSummary(tracker, b.myTarget),
      updated_at: new Date().toISOString()
    };
    var r = await upsertWithRetry("board", row);
    // Transitional: pub column not migrated yet — never let that block the
    // board push itself (completed counts + metcon results must still sync).
    if (r.error && /\bpub\b/.test(r.error.message || "")) {
      delete row.pub;
      r = await upsertWithRetry("board", row);
    }
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
  sb.auth.onAuthStateChange(function (e, s) {
    accessToken = (s && s.access_token) || null;
    // A sign-out we did not initiate means the session died under us (revoked
    // refresh token, or a refresh that can never succeed). Surface it — and
    // NEVER navigate: unsynced work may exist only in memTracker.
    if (e === "SIGNED_OUT" && !signingOut) { sessionDead = true; syncShow("reauth"); }
    // Healed on its own: drop the warning and flush whatever piled up.
    else if (e === "SIGNED_IN" || e === "TOKEN_REFRESHED") {
      if (sessionDead) { sessionDead = false; if (unsynced()) { doPushState(); doPushBoard(); } }
    }
  });
  function keepalivePush() {
    if (!pushCtx.uid || !accessToken) return;
    var raw = memTracker !== null ? memTracker : rawGet(K.TRACKER_KEY);
    var stamp = rawGet(DIRTY_KEY);
    if (!raw || !unsynced()) return;
    try {
      // Preferred channel (v1.7.3): push ONLY the days written this session
      // through the push_days RPC — a few days are ~2KB and always fit under
      // the 64KB keepalive cap that the full blob outgrew. The RPC applies
      // day-level last-writer-wins server-side (same stamps as the boot
      // merge), so a stale device can't clobber a newer day through it.
      // Dirty markers are deliberately NOT cleared on success: the page is
      // dying and .then() may never run — the next open's full push + boot
      // merge reconcile either way, and re-sending an already-applied day is
      // idempotent. This closes the last data-loss hole: a workout logged
      // seconds before closing now reaches the cloud even when localStorage
      // is silently dead (memDirtyDays lives in memory, like memTracker).
      var dayKeys = Object.keys(memDirtyDays);
      if (dayKeys.length) {
        var wk = null;
        try { wk = (JSON.parse(raw) || {}).weeks || []; } catch (e2) { wk = []; }
        var all = dtsGet(), days = {}, dts = {}, sent = 0;
        for (var di = 0; di < dayKeys.length; di++) {
          var kp = dayKeys[di].split("_");
          var dayObj = wk[+kp[0]] && wk[+kp[0]].days ? wk[+kp[0]].days[+kp[1]] : undefined;
          if (dayObj) { days[dayKeys[di]] = dayObj; dts[dayKeys[di]] = all[dayKeys[di]] || Date.now(); sent++; }
        }
        var rbody = JSON.stringify({ p_days: days, p_dts: dts });
        if (sent && rbody.length <= KEEPALIVE_MAX) {
          fetch(window.SUPA_URL + "/rest/v1/rpc/push_days", {
            method: "POST",
            keepalive: true,
            headers: {
              apikey: window.SUPA_ANON_KEY,
              Authorization: "Bearer " + accessToken,
              "Content-Type": "application/json"
            },
            body: rbody
          }).then(function (res) {
            if (res.ok) { try { localStorage.removeItem(KA_KEY); } catch (e) {} return; }
            // 404 = the RPC is not installed on the DB yet (push_days.sql
            // pending) — record it distinctly so the gap is visible.
            console.warn("[sync] keepalive RPC rejected: HTTP " + res.status);
            try { localStorage.setItem(KA_KEY, res.status === 404 ? "norpc" : (res.status === 401 || res.status === 403 ? "auth" : "rpc" + res.status)); } catch (e) {}
          }).catch(function (e) {
            console.warn("[sync] keepalive RPC failed:", (e && e.message) || e);
            try { localStorage.setItem(KA_KEY, "neterr"); } catch (e2) {}
          });
          return;
        }
      }
      // Fallback: the whole blob — only possible while it still fits (it
      // stopped fitting once the program grew), or when the pending change is
      // not day-shaped (e.g. an admin plan edit carries no day stamps).
      var body = JSON.stringify({ user_id: pushCtx.uid, tracker: Object.assign(JSON.parse(raw), { _dts: dtsGet() }), updated_at: new Date().toISOString() });
      // Browsers cap a keepalive request body at 64KB TOTAL and reject beyond
      // it. The tracker blob passed that cap once the program grew, so this
      // channel has been failing on every close — silently, because the
      // rejection landed in an empty catch. Don't burn a guaranteed-failed
      // request: say so, and let the dirty stamp + boot merge do the work.
      if (body.length > KEEPALIVE_MAX) {
        console.warn("[sync] keepalive skipped: body " + body.length + "B > " + KEEPALIVE_MAX + "B cap — relying on dirty-stamp recovery");
        try { localStorage.setItem(KA_KEY, "size"); } catch (e) {}
        return;
      }
      fetch(window.SUPA_URL + "/rest/v1/states?on_conflict=user_id", {
        method: "POST",
        keepalive: true,
        headers: {
          apikey: window.SUPA_ANON_KEY,
          Authorization: "Bearer " + accessToken,
          "Content-Type": "application/json",
          Prefer: "resolution=merge-duplicates"
        },
        body: body
      }).then(function (res) {
        if (res.ok) {
          if (rawGet(DIRTY_KEY) === stamp) { try { localStorage.removeItem(DIRTY_KEY); } catch (e) {} }
          try { localStorage.removeItem(KA_KEY); } catch (e) {}
          return;
        }
        // Non-ok used to have no branch at all. The dirty stamp is deliberately
        // left in place so boot recovery re-pushes; record WHY so the next open
        // can tell a dead session apart from a network blip.
        console.warn("[sync] keepalive push rejected: HTTP " + res.status);
        try { localStorage.setItem(KA_KEY, res.status === 401 || res.status === 403 ? "auth" : String(res.status)); } catch (e) {}
      }).catch(function (e) {
        console.warn("[sync] keepalive push failed:", (e && e.message) || e);
        try { localStorage.setItem(KA_KEY, "neterr"); } catch (e2) {}
      });
    } catch (e) { console.warn("[sync] keepalive push threw:", (e && e.message) || e); }
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
      if (unsynced()) { doPushState(); doPushBoard(); }
      else { checkCloudFresh(); checkFreshBundle(); }
      // Also nudge the SW update check — for long-lived PWA pages the browser
      // may not look for a new sw.js on its own for up to 24h.
      try {
        if ("serviceWorker" in navigator && navigator.serviceWorker.getRegistration)
          navigator.serviceWorker.getRegistration().then(function (r) { if (r) r.update(); }).catch(function () {});
      } catch (e) {}
    }
  });
  window.addEventListener("pagehide", function () { flushPending(); keepalivePush(); });
  // Push again when connectivity returns, in case a push failed offline.
  window.addEventListener("online", function () {
    if (unsynced()) { doPushState(); doPushBoard(); }
  });
  window.addEventListener("offline", function () {
    if (unsynced()) syncShow("offline");
  });
  // Belt & braces: anything still unsynced is retried every 15s while the app
  // is open — covers a retry timer lost to tab suspension. Skipped when a
  // debounced push is already scheduled.
  setInterval(function () {
    // Watchdog: iOS can strand an in-flight fetch forever (background
    // suspension / network handoff) — a wedged pushBusy would silently stop
    // every future states push until reload.
    if (pushBusy && Date.now() - pushStartedAt > 60000) pushBusy = false;
    if (pushCtx.uid && !t1 && unsynced() && navigator.onLine !== false) doPushState();
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
      var isTracker = key === K.TRACKER_KEY && !suppressPush;
      // Board mirror: only USER writes — realtime refreshes (suppressPush)
      // carry other athletes' rows read from possibly-stale storage, and must
      // not overwrite the user's own latest myResults/myName in the mirror.
      if (key === K.BOARD_KEY && !suppressPush) memBoard = val;
      // Diff against the previous write's mirror, not storage — if storage is
      // dead, rawGet keeps answering with the last persisted copy and every
      // write would re-diff (and re-stamp) against that stale base.
      var prevRaw = isTracker ? (memTracker !== null ? memTracker : rawGet(K.TRACKER_KEY)) : null;
      if (isTracker) {
        // Mirror BEFORE attempting to persist: the cloud push must carry this
        // exact value even if the device write below fails (see doPushState).
        memTracker = val; memSeq++; memDirty = true;
        try {
          var ck = stampChangedDays(prevRaw, val);
          for (var ci = 0; ck && ci < ck.length; ci++) memDirtyDays[ck[ci]] = 1;
        } catch (e) {}
        try { orig(DIRTY_KEY, String(Date.now())); } catch (e) {}
      }
      // The app swallows setItem failures (quota full / restricted mode) — the
      // user would keep logging workouts while NOTHING persists on the device.
      // Verify by reading back (iOS can also fail without throwing), alert
      // loudly, and STILL push to Supabase — the cloud copy is the real net.
      var failed = false;
      try { orig(key, val); if (rawGet(key) !== val) failed = true; }
      catch (e) { failed = true; }
      if (failed && (key === K.TRACKER_KEY || key === K.BOARD_KEY)) syncShow("localfail");
      if (suppressPush) return;
      if (key === K.TRACKER_KEY) {
        // Stamped + marked unsynced above, BEFORE the persist attempt (cleared
        // only after Supabase confirms). Instant feedback — the badge used to
        // appear only after the 800ms debounce, i.e. after a fast app close.
        if (!failed) syncShow("saving");
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
      ".cfa-annst{font-size:12px;color:#8ea3c9}" +
      ".cfa-annlog{margin-top:12px;border-top:1px solid #243657;padding-top:10px;display:flex;flex-direction:column;gap:8px}" +
      ".cfa-annlog-item{background:#16233f;border:1px solid #243657;border-radius:10px;padding:10px 12px}" +
      ".cfa-annlog-head{display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:13px}" +
      ".cfa-annlog-head b{color:#eaf0ff}" +
      ".cfa-annlog-when{color:#8ea3c9;font-size:11.5px;margin-inline-start:auto;direction:ltr}" +
      ".cfa-annlog-badge{font-size:10px;padding:1px 7px;border-radius:12px;font-weight:700}" +
      ".cfa-annlog-badge.live{background:#2ecc7133;color:#7ee2a8}" +
      ".cfa-annlog-badge.rem{background:#e74c3c22;color:#ff8a80}" +
      ".cfa-annlog-body{color:#c9d6f2;font-size:12.5px;margin-top:6px;white-space:pre-wrap;line-height:1.5;word-break:break-word}" +
      ".cfa-annlog-foot{margin-top:8px;display:flex;gap:10px;align-items:center;flex-wrap:wrap}" +
      ".cfa-annlog-edit{background:transparent;border:1px solid #2e4a7d;color:#9fc2ff;border-radius:6px;padding:4px 10px;font:700 11px 'Heebo',sans-serif;cursor:pointer}" +
      ".cfa-annlog-edit:hover{background:#2e4a7d;color:#fff}" +
      ".cfa-annlog-note{font-size:11px;color:#ffb74d;margin:0}" +
      ".cfa-annlog-empty{font-size:12px;color:#8ea3c9;margin:0}" +
      // the panel's own scrollbar was invisible (dark thumb on dark bg) — make
      // it clearly visible so desktop users see THIS is the thing to scroll
      "#cfbyAdminOv::-webkit-scrollbar{width:10px}" +
      "#cfbyAdminOv::-webkit-scrollbar-thumb{background:rgba(255,255,255,.28);border-radius:8px}" +
      "#cfbyAdminOv::-webkit-scrollbar-track{background:rgba(255,255,255,.06)}";
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
            '<button class="cfa-prev" id="cfaAnnLogBtn">📜 יומן הודעות</button>' +
            '<span class="cfa-annst" id="cfaAnnSt"></span>' +
          '</div>' +
          '<div class="cfa-annlog" id="cfaAnnLog" style="display:none"></div>' +
        '</div>' +
        '<div class="cfa-ann">' +
          '<h3>🏁 כרטיס סיכום בלוק</h3>' +
          '<p class="sub">כשהאופציה פתוחה, כל מתאמן יכול להפיק כרטיס שיתוף אישי לסיום הבלוק (סטורי + פיד). ' +
            'סגור = אף אחד לא רואה את הכפתור. אתה רואה תצוגה מקדימה של הכרטיס שלך גם כשהאופציה סגורה.</p>' +
          '<div class="row">' +
            '<button class="cfa-pub" id="cfaRecapOpen">🏁 פתח לכולם</button>' +
            '<button class="cfa-annclr" id="cfaRecapClose">🔒 סגור</button>' +
            '<span class="cfa-annst" id="cfaRecapSt"></span>' +
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

    // ---- announcement LOG: the admin's "what did I send and when" -------
    // Every publish appends the full message to shared_program.announcement_log
    // (append-only; clearing an active message early stamps removed_at on its
    // entry). The column may not exist until the updated schema.sql runs, so
    // every write falls back to the announcement-only shape — the log must
    // never be the reason a publish fails.
    function annMissingLogCol(err) {
      var m = (err && err.message) || "";
      return /announcement_log/.test(m) && /column|schema/i.test(m);
    }
    async function annFetch() {
      var r = await sb.from("shared_program").select("announcement,announcement_log").eq("id", 1).maybeSingle();
      if (r.error && annMissingLogCol(r.error)) {
        var r2 = await sb.from("shared_program").select("announcement").eq("id", 1).maybeSingle();
        var act2 = (r2.data && r2.data.announcement) || null;
        // no log column yet — the view can still show the one active message
        // (writes stay announcement-only while noCol is set, so this is safe)
        return { active: act2, log: act2 ? [act2] : [], noCol: true, err: r2.error };
      }
      var log = (r.data && Array.isArray(r.data.announcement_log)) ? r.data.announcement_log.slice() : [];
      var act = (r.data && r.data.announcement) || null;
      // an active message published before the log existed joins it here, and
      // the next publish/clear persists the backfill
      if (act && act.id && !log.some(function (e) { return e && e.id === act.id; })) log.push(act);
      return { active: act, log: log, err: r.error };
    }
    async function annPublish() {
      var d = annDraft();
      if (!d.title && !d.body) { amsg("כתוב כותרת או תוכן להודעה", "err"); return; }
      var ann = { id: "a" + Date.now(), title: d.title || "בלוק חדש התחיל!", body: d.body, created_at: new Date().toISOString() };
      amsg("מפרסם…");
      var cur = await annFetch();
      var payload = { id: 1, announcement: ann };
      // a failed pre-read must not block publishing — worst case this entry
      // is missing from the log, never the other way around
      if (!cur.noCol && !cur.err) payload.announcement_log = cur.log.concat([ann]);
      var r = await sb.from("shared_program").upsert(payload);
      if (r.error && payload.announcement_log && annMissingLogCol(r.error))
        r = await sb.from("shared_program").upsert({ id: 1, announcement: ann });
      if (r.error) {
        var m = r.error.message || String(r.error);
        if (/announcement/.test(m) && /column|schema/i.test(m))
          m = "עמודת announcement חסרה ב-Supabase — יש להריץ את supabase/schema.sql ב-SQL Editor ואז לנסות שוב";
        amsg("הפרסום נכשל: " + m, "err"); return;
      }
      // Deliberately NOT marking the author as seen (was v1.6.0 behavior):
      // the admin wants his own popup too — it pops once on his next app
      // open, exactly like every other user (the on-show marking in main()
      // keeps it once-per-user).
      amsg("ההודעה פורסמה — כל מתאמן, וגם אתה, יראה אותה פעם אחת בכניסה הבאה 🎖️", "ok");
      annStatus(); annLogRender();
    }
    async function annClear() {
      if (!confirm("להסיר את ההודעה הפעילה?\nמי שעדיין לא ראה אותה — כבר לא יראה אותה.")) return;
      var cur = await annFetch();
      var payload = { id: 1, announcement: null };
      if (!cur.noCol && !cur.err && cur.active && cur.active.id) {
        payload.announcement_log = cur.log.map(function (e) {
          if (!e || e.id !== cur.active.id || e.removed_at) return e;
          var stamped = {}; for (var k in e) stamped[k] = e[k];
          stamped.removed_at = new Date().toISOString();
          return stamped;
        });
      }
      var r = await sb.from("shared_program").upsert(payload);
      if (r.error && payload.announcement_log && annMissingLogCol(r.error))
        r = await sb.from("shared_program").upsert({ id: 1, announcement: null });
      if (r.error) { amsg("ההסרה נכשלה: " + (r.error.message || r.error), "err"); return; }
      document.getElementById("cfaAnnT").value = ""; document.getElementById("cfaAnnB").value = "";
      amsg("ההודעה הוסרה", "ok"); annStatus(); annLogRender();
    }

    // ---- block recap gate (open / close) --------------------------------
    // One jsonb column on the same shared_program row the announcement uses.
    // The card does not open itself — Ori opens it here at the end of the
    // block (29/08 decision). Same column-tolerance convention as the
    // announcement log: a missing column degrades the panel, never crashes
    // it, and for athletes missing/failed always reads as closed.
    function recapMissingCol(err) {
      var m = (err && err.message) || "";
      return /block_recap/.test(m) && /column|schema/i.test(m);
    }
    // After a successful write, the running app on THIS device updates live
    // (same event the boot fetch fires); other devices pick it up next boot.
    function recapBroadcast(flag) {
      window.cfbyBlockRecap = flag || null;
      try { window.dispatchEvent(new CustomEvent("cfby-recap-flag", { detail: window.cfbyBlockRecap })); } catch (e) {}
    }
    async function recapStatus() {
      var el = document.getElementById("cfaRecapSt");
      if (!el) return;
      try {
        var r = await sb.from("shared_program").select("block_recap").eq("id", 1).maybeSingle();
        if (r.error && recapMissingCol(r.error)) {
          el.textContent = "עמודת block_recap חסרה — יש להריץ את ה-ALTER TABLE ב-SQL Editor";
          return;
        }
        var f = r.data && r.data.block_recap;
        if (f && f.open === true) {
          var when = f.opened_at ? new Date(f.opened_at).toLocaleDateString("he-IL") : "";
          el.textContent = "פתוח לכולם" + (when ? " · מאז " + when : "");
        } else el.textContent = "סגור — תצוגה מקדימה רק לך, ורק במצב מנהל באפליקציה";
      } catch (e) { el.textContent = ""; }
    }
    async function recapOpenGate() {
      if (!confirm("לפתוח את כרטיס סיכום הבלוק לכל המתאמנים?\nהכפתור יופיע אצל כל אחד בכניסה הבאה לאפליקציה.")) return;
      amsg("פותח…");
      var flag = { open: true, opened_at: new Date().toISOString() };
      var r = await sb.from("shared_program").upsert({ id: 1, block_recap: flag });
      if (r.error) {
        var m = r.error.message || String(r.error);
        if (recapMissingCol(r.error))
          m = "עמודת block_recap חסרה ב-Supabase — יש להריץ: alter table public.shared_program add column if not exists block_recap jsonb;";
        amsg("הפתיחה נכשלה: " + m, "err"); return;
      }
      recapBroadcast(flag);
      amsg("כרטיס הסיכום פתוח לכולם 🏁", "ok"); recapStatus();
    }
    async function recapCloseGate() {
      if (!confirm("לסגור את כרטיס סיכום הבלוק?\nהכפתור ייעלם אצל המתאמנים (אצלך תישאר תצוגה מקדימה).")) return;
      amsg("סוגר…");
      var r = await sb.from("shared_program").upsert({ id: 1, block_recap: null });
      if (r.error) { amsg("הסגירה נכשלה: " + (r.error.message || r.error), "err"); return; }
      recapBroadcast(null);
      amsg("כרטיס הסיכום נסגר", "ok"); recapStatus();
    }

    // ---- announcement log VIEW ------------------------------------------
    var annLogOpen = false, annLogEntries = [];
    function annEsc(s) {
      return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
        return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
      });
    }
    function annWhen(s) {
      if (!s) return "";
      try {
        var d = new Date(s);
        return d.toLocaleDateString("he-IL", { day: "2-digit", month: "2-digit", year: "numeric" }) +
               " · " + d.toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" });
      } catch (e) { return ""; }
    }
    async function annLogRender() {
      var box = document.getElementById("cfaAnnLog");
      if (!box || !annLogOpen) return;
      box.style.display = "";
      box.innerHTML = '<p class="cfa-annlog-empty">טוען…</p>';
      var cur = await annFetch();
      if (cur.err) { box.innerHTML = '<p class="cfa-annlog-empty">טעינת היומן נכשלה: ' + annEsc(cur.err.message || cur.err) + "</p>"; return; }
      annLogEntries = cur.log.slice().reverse();          // newest first
      var html = "";
      if (cur.noCol)
        html += '<p class="cfa-annlog-note">⚠️ שמירת ההיסטוריה עוד לא הופעלה במסד — יש להריץ את supabase/schema.sql המעודכן ב-SQL Editor. בינתיים מוצגת רק ההודעה הפעילה.</p>';
      if (!annLogEntries.length) {
        box.innerHTML = html + '<p class="cfa-annlog-empty">עוד לא פורסמו הודעות בלוק.</p>';
        return;
      }
      html += annLogEntries.map(function (e, i) {
        var live = cur.active && cur.active.id === e.id && !e.removed_at;
        var badge = live ? '<span class="cfa-annlog-badge live">🟢 פעילה עכשיו</span>'
                  : e.removed_at ? '<span class="cfa-annlog-badge rem">הוסרה ידנית</span>' : "";
        var foot = '<button class="cfa-annlog-edit" data-i="' + i + '">✎ טען לעריכה</button>' +
                   (e.removed_at ? '<span class="cfa-annlog-empty">הוסרה ב-' + annWhen(e.removed_at) + "</span>" : "");
        return '<div class="cfa-annlog-item">' +
                 '<div class="cfa-annlog-head"><b>' + annEsc(e.title || "(ללא כותרת)") + "</b>" + badge +
                   '<span class="cfa-annlog-when">🗓 ' + annWhen(e.created_at) + "</span></div>" +
                 (e.body ? '<div class="cfa-annlog-body">' + annEsc(e.body) + "</div>" : "") +
                 '<div class="cfa-annlog-foot">' + foot + "</div>" +
               "</div>";
      }).join("");
      box.innerHTML = html;
    }
    function annLogToggle() {
      annLogOpen = !annLogOpen;
      var box = document.getElementById("cfaAnnLog"), btn = document.getElementById("cfaAnnLogBtn");
      if (btn) btn.textContent = annLogOpen ? "📜 סגור יומן" : "📜 יומן הודעות";
      if (!annLogOpen) { if (box) box.style.display = "none"; return; }
      annLogRender();
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

    // While the panel is open, the app behind it must not scroll: its (body)
    // scrollbar sits at the same right edge as the panel's and swallowed the
    // scrolling on desktop — the app scrolled invisibly while the panel stood
    // still. Lock the page scroll on open, restore on close.
    function openPanel() {
      ov.classList.add("open");
      document.documentElement.style.overflow = "hidden";
      bkInfo(); annStatus(); recapStatus(); refresh();
    }
    function closePanel() {
      ov.classList.remove("open");
      document.documentElement.style.overflow = "";
      amsg("");
    }
    document.getElementById("cfaAnnPub").onclick = annPublish;
    document.getElementById("cfaAnnClr").onclick = annClear;
    document.getElementById("cfaRecapOpen").onclick = recapOpenGate;
    document.getElementById("cfaRecapClose").onclick = recapCloseGate;
    document.getElementById("cfaAnnPrev").onclick = function () {
      var d = annDraft();
      window.__cfbyAnnPreview({ title: d.title || "בלוק חדש התחיל!", body: d.body }, function () {});
    };
    document.getElementById("cfaAnnLogBtn").onclick = annLogToggle;
    // "load to editor" buttons are re-created on every render — delegate once
    document.getElementById("cfaAnnLog").onclick = function (ev) {
      var b = ev.target && ev.target.closest ? ev.target.closest(".cfa-annlog-edit") : null;
      if (!b) return;
      var e = annLogEntries[+b.getAttribute("data-i")];
      if (!e) return;
      document.getElementById("cfaAnnT").value = e.title || "";
      document.getElementById("cfaAnnB").value = e.body || "";
      amsg("ההודעה נטענה לעריכה — לחיצה על 📣 תפרסם אותה מחדש כהודעה חדשה לכולם");
      document.getElementById("cfaAnnT").focus();
      var annBox = document.querySelector(".cfa-ann");
      if (annBox && annBox.scrollIntoView) annBox.scrollIntoView({ behavior: "smooth", block: "start" });
    };
    document.getElementById("cfaX").onclick = closePanel;
    // NO backdrop-click close: the box has no background of its own, so on wide
    // screens the overlay margins look like part of the panel — and on Windows,
    // clicking the overlay's own scrollbar targets the overlay too. Both used to
    // slam the panel shut on desktop. Close only via ✕ or Escape.
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && ov.classList.contains("open")) closePanel();
    });
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
        // close the panel if admin mode was just exited
        if (ov.classList.contains("open")) closePanel();
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
    // dev preview: the recap gate is open so the share flow is testable
    // without Supabase. localhost-only — a hosted deployment never runs this.
    window.cfbyBlockRecap = { open: true, opened_at: "2026-09-05T00:00:00.000Z", _dev: true };
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

    // Why the previous close-time push failed, if it did. That push runs while
    // the page is dying, so this read-back is the only way the reason ever
    // surfaces. Diagnostic only — the day-level boot merge below already
    // recovers the DATA, so this must never alarm the user.
    var kaFail = rawGet(KA_KEY);
    if (kaFail) {
      console.warn("[sync] previous close-time push did not land (" + kaFail + ") — recovering via boot merge");
      try { localStorage.removeItem(KA_KEY); } catch (e) {}
    }

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
    // v1.7.0: local and server are MERGED day by day (see mergeTrackers) —
    // each day survives from whichever side touched it last. This replaces
    // "last whole notebook wins", which let any second device/storage-context
    // silently erase workouts synced from the first.
    var localTracker = lsGet(K.TRACKER_KEY);
    var localDts = lsGet(DTS_KEY) || {};
    var st = await fetchMyState(uid);
    if (st.error && !(localTracker && localTracker.weeks)) {
      // Server unreachable and nothing local to boot from — wait, don't guess.
      st = await waitForServer(uid);
    }
    var mine = st.row;
    if (mine && mine.updated_at) lastServerStamp = mine.updated_at;
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
      var serverDts = mine.tracker._dts || {};
      delete mine.tracker._dts;                 // internal — the app must never see it
      var serverTs = mine.updated_at ? Date.parse(mine.updated_at) || 0 : 0;
      if (localTracker && localTracker.weeks) {
        var mg = mergeTrackers(localTracker, localDts, mine.tracker, serverDts, dirtyTs > serverTs);
        // Mirrors first, storage best-effort: the merged truth must survive a
        // storage that throws (quota) — that used to be a fatal boot crash on
        // the very devices whose storage failure we are recovering from.
        memTracker = JSON.stringify(mg.tracker); memDts = mg.dts;
        try { lsSetRaw(K.TRACKER_KEY, mg.tracker); } catch (e) {}
        try { lsSetRaw(DTS_KEY, mg.dts); } catch (e) {}
        if (mg.localWon) {
          // The merge carries days the cloud doesn't have — push it up. Mark
          // dirty so every retry channel covers this push too.
          try { localStorage.setItem(DIRTY_KEY, String(Date.now())); } catch (e) {}
          keepLocal = true;
        } else {
          try { localStorage.removeItem(DIRTY_KEY); } catch (e) {}
        }
      } else {
        // fresh device: adopt the cloud copy (mirrors first, storage best-effort)
        memTracker = JSON.stringify(mine.tracker); memDts = serverDts;
        try { lsSetRaw(K.TRACKER_KEY, mine.tracker); } catch (e) {}
        try { lsSetRaw(DTS_KEY, serverDts); } catch (e) {}
        try { localStorage.removeItem(DIRTY_KEY); } catch (e) {}
      }
    } else if (localTracker && localTracker.weeks && dirtyTs > 0) {
      // The server answered "no row" BUT this device holds unsynced data: the
      // cloud simply never received it (a brand-new user whose first-session
      // pushes all died with the mobile lifecycle / gym reception). The old
      // code wiped the device here — THE data-loss bug for new users. Keep
      // local; the push below creates the row.
      keepLocal = true;
    } else {
      // The server ANSWERED, there is no row, and nothing unsynced is at
      // stake: confirmed fresh user, or an admin wiped this account's data.
      // Clear any stale local copy so deleted data can never resurrect, then
      // seed the published program (scaffold only, stripped of any logs an
      // older buggy publish may have left in shared_program).
      memTracker = null; memDts = null;         // deleted data must not resurrect from mirrors either
      try { localStorage.removeItem(K.TRACKER_KEY); localStorage.removeItem(DIRTY_KEY); localStorage.removeItem(DTS_KEY); } catch (e) {}
      var prog = await fetchSharedProgram();    // fresh user -> admin's published program
      if (prog) {
        var seedT = { v: 2, weeks: stripLogs(prog) };
        memTracker = JSON.stringify(seedT);
        try { lsSetRaw(K.TRACKER_KEY, seedT); } catch (e) {}
      }
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
    var seedB = {
      board: (fb.error && Array.isArray(prevB.board) && prevB.board.length) ? prevB.board : board,
      myName: (myRow && myRow.name) || (fb.error && prevB.myName) || prof.name || (session.user.email || "").split("@")[0],
      myResults: (myRow && myRow.results) || (fb.error && prevB.myResults) || {},
      myCategory: categoryOf(prof.gender, prof.birth_date),
      myGender: prof.gender || null,
      myAge: ageFrom(prof.birth_date)
    };
    memBoard = JSON.stringify(seedB);
    try { lsSetRaw(K.BOARD_KEY, seedB); } catch (e) {}

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
    // scope:"local" — the default is "global", which revokes the refresh token
    // on EVERY device. Signing out on the phone would kill the tablet's session
    // mid-workout, which is one way sessions died under users in the first place.
    window.cfbySignOut = async function () {
      signingOut = true;                       // a deliberate sign-out is not a fault
      try { await sb.auth.signOut({ scope: "local" }); } catch (e) {}
      location.replace("index.html");
    };
    window.cfbyIsAdmin = isAdmin;
    // Block-recap gate: null = closed. The real flag arrives with the
    // announcement fetch below (after app boot) and fires cfby-recap-flag.
    window.cfbyBlockRecap = null;

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
    fetchAnnouncement().then(function (res) {
      // Block-recap gate flag: hand it to the app the same way isAdmin travels
      // (window var), plus an event for the already-rendered app to pick up.
      // This runs OUTSIDE the prof._err guard — a flaky profile fetch must not
      // hide an open recap from athletes; only the popup needs the seen-marker.
      window.cfbyBlockRecap = (res && res.block_recap) || null;
      try { window.dispatchEvent(new CustomEvent("cfby-recap-flag", { detail: window.cfbyBlockRecap })); } catch (e) {}
      var ann = res && res.announcement;
      if (prof._err) return;
      if (!ann || !ann.id) return;
      if (prof.announcement_seen === ann.id) return;
      if (rawGet("cfby_ann_seen") === ann.id) return;   // device fallback if the upsert below failed
      showAnnouncement(ann, function () {
        try { localStorage.setItem("cfby_ann_seen", ann.id); } catch (e) {}
        sb.from("profiles").upsert({ id: uid, announcement_seen: ann.id })
          .then(function () {}, function () {});
      });
    }).catch(function () {});

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
