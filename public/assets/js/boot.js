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

  // NOTE: program/results merging is NOT done here any more. The app owns it:
  // normalizeWeeks() coerces any saved blob into its canonical shape, and
  // applyProgram() overlays the built-in program when the saved program version
  // is older than the app's. boot.js just seeds the raw blob and lets the app
  // reconcile it.

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
    var r = await sb.from("board").select("user_id,name,results,weeks").order("name");
    return r.data || [];
  }
  async function fetchProfile(uid) {
    var r = await sb.from("profiles").select("name,is_admin,welcome_seen,gender,birth_date").eq("id", uid).maybeSingle();
    return r.data || { name: "", is_admin: false, welcome_seen: false, gender: null, birth_date: null };
  }
  // Every registered athlete — the leaderboard is built from this so a user
  // appears the moment their account exists, before they log any workout.
  async function fetchAllProfiles() {
    var r = await sb.from("profiles").select("id,name,is_admin,gender,birth_date");
    return r.data || [];
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
  function pushBoard(uid, isAdmin) {
    // Admins compete on the leaderboard like everyone else (their extra powers
    // are the panel + program editing, not board visibility).
    clearTimeout(t2);
    t2 = setTimeout(async function () {
      var b = lsGet(K.BOARD_KEY) || {};
      var tracker = lsGet(K.TRACKER_KEY);
      await sb.from("board").upsert({
        user_id: uid,
        name: b.myName || "",
        results: b.myResults || {},
        weeks: summarizeWeeks(tracker, b.myResults),
        updated_at: new Date().toISOString()
      });
    }, 800);
  }

  // When boot.js itself rewrites the board (e.g. a realtime refresh of other
  // athletes), suppress the interceptor so it does not push our own row back
  // and cause an echo loop.
  var suppressPush = false;

  // Intercept the app's own localStorage writes
  function installInterceptor(uid, isAdmin) {
    var orig = localStorage.setItem.bind(localStorage);
    localStorage.setItem = function (key, val) {
      orig(key, val);
      if (suppressPush) return;
      if (key === K.TRACKER_KEY) {
        pushState(uid, isAdmin);
        // A completed workout only writes the tracker, but the leaderboard's
        // "completed" counts are derived from it — so sync the board too, or a
        // user who just marks workouts done never appears on anyone's board.
        pushBoard(uid, isAdmin);
      } else if (key === K.BOARD_KEY) {
        pushBoard(uid, isAdmin);
      }
    };
  }

  // ---- realtime leaderboard -------------------------------------------
  // Refresh ONLY the other athletes' rows (never our own fields) so anyone
  // else's change appears live, without a page refresh.
  var rtTimer = null;
  async function refreshOthers(uid) {
    var rows = await fetchBoard();
    var byId = {}; rows.forEach(function (r) { byId[r.user_id] = r; });
    var profs = await fetchAllProfiles();
    var board = profs
      .filter(function (p) { return p.id !== uid; })
      .map(function (p) { var r = byId[p.id]; return { id: p.id, name: (r && r.name) || p.name || "", weeks: (r && r.weeks) || [], category: categoryOf(p.gender, p.birth_date) }; });
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
          clearTimeout(rtTimer);
          rtTimer = setTimeout(function () { refreshOthers(uid).catch(function () {}); }, 500);
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
      ".cfa-stat{color:#8ea3c9;font-size:12px;margin-bottom:10px}";
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
          '<td>' + (isMe ? '—' : '<button class="cfa-del" data-id="' + u.id + '" data-name="' + (u.name || "") + '">מחק</button>') + '</td></tr>';
      }).join("");
      document.getElementById("cfaList").innerHTML =
        '<table class="cfa-t"><thead><tr><th>שם</th><th>שם משתמש</th><th>פעילות</th><th>אימונים</th><th></th></tr></thead><tbody>' + rows + '</tbody></table>';
      Array.prototype.forEach.call(document.querySelectorAll(".cfa-del"), function (b) {
        b.onclick = function () { del(b.getAttribute("data-id"), b.getAttribute("data-name")); };
      });
    }

    async function del(uid, name) {
      if (!confirm('למחוק לצמיתות את "' + (name || "המשתמש") + '"?\nהחשבון וכל הנתונים יימחקו והוא לא יוכל להתחבר יותר.')) return;
      try {
        // admin_delete_user removes the auth account too (cascades to all tables),
        // so a deleted user truly can't sign back in.
        var r = await sb.rpc("admin_delete_user", { target: uid });
        if (r.error) throw r.error;
        amsg("נמחק.", "ok"); refresh();
      } catch (e) { amsg("מחיקה נכשלה: " + (e.message || e), "err"); }
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

    function openPanel() { ov.classList.add("open"); refresh(); }
    document.getElementById("cfaX").onclick = function () { ov.classList.remove("open"); amsg(""); };
    ov.onclick = function (e) { if (e.target === ov) { ov.classList.remove("open"); amsg(""); } };
    document.getElementById("cfaAdd").onclick = addUser;

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

  // ---- main ------------------------------------------------------------
  async function main() {
    var ses = await sb.auth.getSession();
    var session = ses.data && ses.data.session;
    if (!session) { location.replace("index.html"); return; }
    var uid = session.user.id;

    var prof = await fetchProfile(uid);
    var isAdmin = !!prof.is_admin;

    // First login: collect gender + birth date (needed for the competition
    // category). Blocks the app until answered, then refetches the profile.
    if (!prof.gender || !prof.birth_date) {
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
    var mine = await fetchMyState(uid);
    if (mine && mine.weeks) {
      lsSetRaw(K.TRACKER_KEY, mine);            // this user's own saved blob
    } else {
      var prog = await fetchSharedProgram();    // fresh user -> admin's published program
      if (prog) lsSetRaw(K.TRACKER_KEY, { v: 2, weeks: prog });
      // else: leave empty -> the app builds its built-in program
    }

    // 2) board (shared leaderboard). Built from the full roster of registered
    //    athletes (profiles), so a new user shows up immediately — not only once
    //    they log a workout. Their board row (completed counts + result) is
    //    merged in when it exists. Everyone competes, admins included; "you" is
    //    rendered by the app separately, so exclude only self here.
    var rows = await fetchBoard();
    var byId = {};
    rows.forEach(function (r) { byId[r.user_id] = r; });
    var profiles = await fetchAllProfiles();
    var board = profiles
      .filter(function (p) { return p.id !== uid; })
      .map(function (p) {
        var r = byId[p.id];
        return { id: p.id, name: (r && r.name) || p.name || "", weeks: (r && r.weeks) || [],
                 category: categoryOf(p.gender, p.birth_date) };
      });
    var myRow = byId[uid];
    lsSetRaw(K.BOARD_KEY, {
      board: board,
      myName: (myRow && myRow.name) || prof.name || (session.user.email || "").split("@")[0],
      myResults: (myRow && myRow.results) || {},
      myCategory: categoryOf(prof.gender, prof.birth_date),
      myGender: prof.gender || null,
      myAge: ageFrom(prof.birth_date)
    });

    // 3) intercept future writes
    installInterceptor(uid, isAdmin);

    // One-time board sync on load: seeding above happens BEFORE the interceptor,
    // so a user who already completed workouts (in their state) wouldn't be on
    // the board until their next change. Push now so they appear immediately.
    pushBoard(uid, isAdmin);

    // expose a manual sign-out for the app if needed
    window.cfbySignOut = async function () { await sb.auth.signOut(); location.replace("index.html"); };
    window.cfbyIsAdmin = isAdmin;

    // 4) NOW boot the app (data is already in localStorage)
    await loadScript("assets/js/html2canvas.js");
    await loadScript("assets/js/dc-runtime.js");
    await revealApp();

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
