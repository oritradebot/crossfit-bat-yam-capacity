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

  // Split a day into PROGRAM scaffold (shared, admin) vs PERSONAL (per user)
  var PROGRAM_FIELDS = ["lift.movement","lift.planned",
    "metcon.name","metcon.scheme","metcon.score","metcon.note","metcon.movements",
    "extras.name","extras.detail"];
  // Overlay the shared program's scaffold onto a user's weeks, keeping results.
  function mergeProgramIntoUser(userWeeks, progWeeks) {
    if (!progWeeks) return userWeeks;
    if (!userWeeks) userWeeks = JSON.parse(JSON.stringify(progWeeks)); // fresh user -> empty results already
    for (var w = 0; w < progWeeks.length; w++) {
      if (!userWeeks[w]) { userWeeks[w] = JSON.parse(JSON.stringify(progWeeks[w])); continue; }
      for (var d = 0; d < progWeeks[w].days.length; d++) {
        var pd = progWeeks[w].days[d], ud = userWeeks[w].days[d];
        if (!ud) { userWeeks[w].days[d] = JSON.parse(JSON.stringify(pd)); continue; }
        // program scaffold -> copy from shared
        ud.lift = ud.lift || {}; pd.lift = pd.lift || {};
        ud.lift.movement = pd.lift.movement; ud.lift.planned = pd.lift.planned;
        ud.metcon = ud.metcon || {}; pd.metcon = pd.metcon || {};
        ud.metcon.name = pd.metcon.name; ud.metcon.scheme = pd.metcon.scheme;
        ud.metcon.score = pd.metcon.score; ud.metcon.note = pd.metcon.note;
        ud.metcon.movements = pd.metcon.movements;
        // extras: keep count from program, preserve user results by index
        pd.extras = pd.extras || []; ud.extras = ud.extras || [];
        for (var i = 0; i < pd.extras.length; i++) {
          ud.extras[i] = ud.extras[i] || {};
          ud.extras[i].name = pd.extras[i].name;
          ud.extras[i].detail = pd.extras[i].detail;
        }
      }
    }
    return userWeeks;
  }

  // ---- Supabase reads --------------------------------------------------
  async function fetchSharedProgram() {
    var r = await sb.from("shared_program").select("weeks").eq("id", 1).maybeSingle();
    return (r.data && r.data.weeks) || null;
  }
  async function fetchMyState(uid) {
    var r = await sb.from("states").select("tracker").eq("user_id", uid).maybeSingle();
    return (r.data && r.data.tracker) || null;
  }
  async function fetchBoard() {
    var r = await sb.from("board").select("user_id,name,results").order("name");
    return r.data || [];
  }
  async function fetchProfile(uid) {
    var r = await sb.from("profiles").select("name,is_admin").eq("id", uid).maybeSingle();
    return r.data || { name: "", is_admin: false };
  }

  // ---- Supabase writes (debounced) ------------------------------------
  var t1 = null, t2 = null;
  function pushState(uid, isAdmin) {
    clearTimeout(t1);
    t1 = setTimeout(async function () {
      var tracker = lsGet(K.TRACKER_KEY);
      if (!tracker) return;
      await sb.from("states").upsert({ user_id: uid, tracker: tracker, updated_at: new Date().toISOString() });
      // Admin also publishes the program scaffold for everyone
      if (isAdmin && tracker.weeks) {
        await sb.from("shared_program").upsert({ id: 1, weeks: tracker.weeks, updated_at: new Date().toISOString() });
      }
    }, 800);
  }
  function pushBoard(uid) {
    clearTimeout(t2);
    t2 = setTimeout(async function () {
      var b = lsGet(K.BOARD_KEY) || {};
      await sb.from("board").upsert({
        user_id: uid,
        name: b.myName || "",
        results: b.myResults || {},
        updated_at: new Date().toISOString()
      });
    }, 800);
  }

  // Intercept the app's own localStorage writes
  function installInterceptor(uid, isAdmin) {
    var orig = localStorage.setItem.bind(localStorage);
    localStorage.setItem = function (key, val) {
      orig(key, val);
      if (key === K.TRACKER_KEY) pushState(uid, isAdmin);
      else if (key === K.BOARD_KEY) pushBoard(uid);
    };
  }

  // ---- main ------------------------------------------------------------
  async function main() {
    var ses = await sb.auth.getSession();
    var session = ses.data && ses.data.session;
    if (!session) { location.replace("index.html"); return; }
    var uid = session.user.id;

    var prof = await fetchProfile(uid);
    var isAdmin = !!prof.is_admin;

    // 1) load + merge program/state
    var prog = await fetchSharedProgram();
    var mine = await fetchMyState(uid);
    if (mine && mine.weeks) {
      mine.weeks = mergeProgramIntoUser(mine.weeks, prog);
      lsSetRaw(K.TRACKER_KEY, mine);
    } else if (prog) {
      lsSetRaw(K.TRACKER_KEY, { v: 2, weeks: prog });
    } // else: leave empty -> app builds its default program

    // 2) board (shared: everyone sees everyone)
    var rows = await fetchBoard();
    var board = rows.map(function (r) { return { id: r.user_id, name: r.name, results: r.results }; });
    var myRow = rows.filter(function (r) { return r.user_id === uid; })[0];
    lsSetRaw(K.BOARD_KEY, {
      board: board,
      myName: (myRow && myRow.name) || prof.name || (session.user.email || "").split("@")[0],
      myResults: (myRow && myRow.results) || {}
    });

    // 3) intercept future writes
    installInterceptor(uid, isAdmin);

    // expose a manual sign-out for the app if needed
    window.cfbySignOut = async function () { await sb.auth.signOut(); location.replace("index.html"); };
    window.cfbyIsAdmin = isAdmin;

    // 4) NOW boot the app (data is already in localStorage)
    await loadScript("assets/js/html2canvas.js");
    await loadScript("assets/js/dc-runtime.js");
  }

  main().catch(function (e) {
    console.error("[boot] fatal", e);
    document.body.insertAdjacentHTML("beforeend",
      '<div style="position:fixed;inset:auto 12px 12px 12px;background:#2a1215;color:#ff8a80;' +
      'font:13px/1.5 monospace;padding:12px;border-radius:8px;z-index:99999">' +
      '[boot] ' + (e && e.message || e) + '</div>');
  });
})();
