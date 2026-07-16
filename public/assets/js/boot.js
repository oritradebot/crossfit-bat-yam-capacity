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
    var r = await sb.from("board").select("user_id,name,results,weeks").order("name");
    return r.data || [];
  }
  async function fetchProfile(uid) {
    var r = await sb.from("profiles").select("name,is_admin,welcome_seen").eq("id", uid).maybeSingle();
    return r.data || { name: "", is_admin: false, welcome_seen: false };
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
  // Per-week summary the leaderboard needs: completed days + shared result
  function summarizeWeeks(tracker, myResults) {
    var out = [], wk = (tracker && tracker.weeks) || [];
    for (var i = 0; i < wk.length; i++) {
      var days = (wk[i] && wk[i].days) || [], done = 0;
      for (var j = 0; j < days.length; j++) { if (days[j] && days[j].done) done++; }
      out.push({ completed: done, result: (myResults && myResults[i]) || 0 });
    }
    return out;
  }
  function pushBoard(uid, isAdmin) {
    if (isAdmin) return;            // invisible admin: never appears on the shared board
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

  // Intercept the app's own localStorage writes
  function installInterceptor(uid, isAdmin) {
    var orig = localStorage.setItem.bind(localStorage);
    localStorage.setItem = function (key, val) {
      orig(key, val);
      if (key === K.TRACKER_KEY) pushState(uid, isAdmin);
      else if (key === K.BOARD_KEY) pushBoard(uid, isAdmin);
    };
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
      if (!confirm('למחוק את "' + (name || "המשתמש") + '"?\nכל הנתונים שלו יימחקו והוא יוסר מהלוח.')) return;
      try {
        // supabase-js does NOT throw on an RLS block — it returns { error }. Check each.
        var err = (await sb.from("board").delete().eq("user_id", uid)).error
               || (await sb.from("states").delete().eq("user_id", uid)).error
               || (await sb.from("profiles").delete().eq("id", uid)).error;
        if (err) throw err;
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

  // ---- main ------------------------------------------------------------
  async function main() {
    var ses = await sb.auth.getSession();
    var session = ses.data && ses.data.session;
    if (!session) { location.replace("index.html"); return; }
    var uid = session.user.id;

    var prof = await fetchProfile(uid);
    var isAdmin = !!prof.is_admin;

    // The guide never auto-pops now — it opens only via the "❓ מדריך" button.
    try { localStorage.setItem(K.WELCOME_KEY, "1"); } catch (e) {}

    // 1) load + merge program/state
    var prog = await fetchSharedProgram();
    var mine = await fetchMyState(uid);
    if (mine && mine.weeks) {
      mine.weeks = mergeProgramIntoUser(mine.weeks, prog);
      lsSetRaw(K.TRACKER_KEY, mine);
    } else if (prog) {
      lsSetRaw(K.TRACKER_KEY, { v: 2, weeks: prog });
    } // else: leave empty -> app builds its default program

    // 2) board (shared leaderboard). Admin is invisible; each user appears once.
    if (isAdmin) {
      // wipe any leftover admin row so the admin never shows up to others
      try { await sb.from("board").delete().eq("user_id", uid); } catch (e) {}
    }
    var rows = await fetchBoard();
    var board = rows
      .filter(function (r) { return r.user_id !== uid; })  // the app renders "you" separately
      .map(function (r) { return { id: r.user_id, name: r.name, weeks: r.weeks || [] }; });
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

    // 5) admins get the in-app user-management panel (floating button)
    if (isAdmin) { try { injectAdminPanel(uid); } catch (e) { console.error("[admin panel]", e); } }
  }

  main().catch(function (e) {
    console.error("[boot] fatal", e);
    document.body.insertAdjacentHTML("beforeend",
      '<div style="position:fixed;inset:auto 12px 12px 12px;background:#2a1215;color:#ff8a80;' +
      'font:13px/1.5 monospace;padding:12px;border-radius:8px;z-index:99999">' +
      '[boot] ' + (e && e.message || e) + '</div>');
  });
})();
