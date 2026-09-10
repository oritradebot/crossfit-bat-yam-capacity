/* ==========================================================================
   Block Recap Share Card — data builder
   CrossFit Bat Yam · Capacity Tracker

   Turns the app's own model (this.state.data — 8 weeks x 7 days) into the
   flat object recap-card.js draws. Pure read: it never writes state, never
   touches the sync blob, never invents a number it cannot source from a
   logged day.

   Drop-in shape: every helper it needs from the app is passed in as `app`
   (the component instance), so inside app.html this becomes
     buildBlockRecap() { return BlockRecap.build(this); }
   and nothing else moves.

   Uses from the app: state.data, state.myName, myTargetVal(), dayComplete(),
   dayHasPR(), metconScore(), dateAt(), pad().
   ========================================================================== */
(function (global) {
  'use strict';

  /* ======================================================================
     CAPACITESTS — where each block test lives in the program.

     Baselines are all in W1. W8 (PROGRAM_VERSION 32) embeds the re-measures
     for tests #1/#2/#3, so those three rows fill in on their own the moment
     a member logs the day. CapaciTest #4 has NO re-measure in the W8 program
     -> its `retest` stays null and that row keeps rendering through the
     "no re-measure" edge case: dashed after-bar, "לא נמדד", muted note.

     slot: { wi, di, src }
       src 'lift.weight' | 'lift.reps' | 'metcon' | 'metcon2' | 'extra0' | 'extra1'
     ====================================================================== */
  // BLOCK 1 tests — kept for /demo only (window.cfbyDemo). See testList().
  var CAPACITESTS_BLOCK1 = [
    { key: 'squat',
      name: 'Back Squat — שלשה כבדה',
      short: 'כוח רגליים',
      unit: 'ק"ג',
      betterWhen: 'higher',
      base:   { wi: 0, di: 0, src: 'lift.weight' },   // CapaciTest #1 (Baseline)
      retest: { wi: 7, di: 0, src: 'lift.weight' }    // W8 — Back Squat 3RM RETEST
    },
    { key: 'aerobic',
      name: 'מבחן אירובי — 3 סבבים',
      short: 'סיבולת אירובית',
      unit: '',
      betterWhen: 'lower',
      base:   { wi: 0, di: 1, src: 'metcon' },        // CapaciTest #2 — Monostructural
      retest: { wi: 7, di: 1, src: 'metcon' }         // W8 — Monostructural RETEST
    },
    { key: 'strictpull',
      name: 'Strict Pull Up — 10 סטים ב־5:00',
      short: 'משיכה בשליטה',
      unit: 'חזרות',
      betterWhen: 'higher',
      base:   { wi: 0, di: 1, src: 'extra0' },        // CapaciTest #3 — Pull Up
      retest: { wi: 7, di: 1, src: 'extra0' }         // W8 — Strict Pull Up RETEST
    },
    { key: 'c2b',
      name: 'C2B/Pull Ups — חזרות לדקה',
      short: "ג'ימנסטיקה",
      unit: 'לדקה',
      betterWhen: 'higher',
      base:   { wi: 0, di: 4, src: 'lift.reps' },     // CapaciTest #4 (Baseline)
      retest: null                                    // no re-measure in W8
    }
  ];
  // BLOCK 2 (Ori, 07/09/2026): the Sunday 4 x 10 Back Squat is the block's
  // test and it repeats EVERY WEEK — a `weekly` slot instead of base/retest:
  // measured on day `di` of each week; the first measured week is the
  // "before", the latest measured week after it is the "after", and the
  // in-app screen also lists every week's value. More tests arrive per embed.
  var CAPACITESTS_BLOCK2 = [
    { key: 'squat10',
      name: 'Back Squat — 4 x 10 (מבחן שבועי)',
      short: 'עשיריות בק סקוואט · כל יום ראשון',
      unit: 'ק"ג',
      betterWhen: 'higher',
      weekly: { di: 0, src: 'lift.weight' }
    }
  ];
  function testList() { return global.cfbyDemo ? CAPACITESTS_BLOCK1 : CAPACITESTS_BLOCK2; }

  /* ---- value readers ---------------------------------------------------- */
  function dayAt(app, wi, di) {
    var wk = app.state.data[wi];
    return wk ? wk.days[di] : null;
  }

  // Returns { v, text } or null. v is the comparable number, text the label
  // the card prints. Never guesses: an unparseable log is simply absent.
  function readSlot(app, slot, test) {
    if (!slot) return null;
    var day = dayAt(app, slot.wi, slot.di);
    if (!day) return null;
    var s = slot.src, n;

    if (s === 'lift.weight') {
      n = parseFloat(day.lift && day.lift.log && day.lift.log.weight);
      return n > 0 ? { v: n, text: trimNum(n) + ' ' + test.unit } : null;
    }
    if (s === 'lift.reps') {
      n = parseInt(day.lift && day.lift.log && day.lift.log.reps, 10);
      return n > 0 ? { v: n, text: String(n) } : null;
    }
    if (s === 'metcon' || s === 'metcon2') {
      var m = day[s], sc = app.metconScore(m);
      if (!sc) return null;
      // rounds-mode scores are a composite (rounds*100000+reps, app.html
      // metconScore) — decode for display or the card prints "300012".
      // The composite stays as v: before/after use the same encoding, so
      // the comparison and the bar ratio stay monotone.
      var txt = sc.dir === 'low' ? mmss(sc.v)
        : (m && m.log && m.log.mode === 'rounds' && sc.v >= 100000)
            ? (Math.floor(sc.v / 100000) + '+' + (sc.v % 100000))
            : String(sc.v);
      return { v: sc.v, text: txt, ltr: sc.dir === 'low' };
    }
    if (s.indexOf('extra') === 0) {
      var e = (day.extras || [])[+s.slice(5)];
      n = parseInt((e && e.log && e.log.text) || '', 10);   // free text — take the leading number
      return n > 0 ? { v: n, text: String(n) } : null;
    }
    return null;
  }

  function trimNum(n) { return String(Math.round(n * 10) / 10); }
  function mmss(sec) {
    var m = Math.floor(sec / 60), s = Math.round(sec % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  /* ---- weekly tests (block 2) ---------------------------------------------
     One value per week (same day, same reader). The slots a weekly test
     exposes to the card are the first measured week and the latest one.   */
  function weeklyPoints(app, t) {
    var pts = [];
    for (var wi = 0; wi < 8; wi++) {
      var r = readSlot(app, { wi: wi, di: t.weekly.di, src: t.weekly.src }, t);
      pts.push(r ? { wi: wi, v: r.v, text: r.text, short: (t.weekly.src === 'lift.weight' ? trimNum(r.v) : r.text), ltr: !!r.ltr } : null);
    }
    return pts;
  }
  function testSlots(app, t) {
    if (!t.weekly) return { base: t.base || null, retest: t.retest || null };
    var m = weeklyPoints(app, t).filter(Boolean);
    var first = m[0] || null, last = m.length > 1 ? m[m.length - 1] : null;
    var slot = function (p) { return p ? { wi: p.wi, di: t.weekly.di, src: t.weekly.src } : null; };
    return { base: slot(first), retest: slot(last) };
  }

  /* ---- one graph row ----------------------------------------------------
     pct = value / max(before, after) — computed per row, so each test owns
     its own scale. On a timed test the slower time is the full bar.         */
  function buildTest(app, t) {
    var S = testSlots(app, t);
    var b = readSlot(app, S.base, t);
    if (!b) return null;                       // never baselined -> not on the card at all
    var a = readSlot(app, S.retest, t);
    var row = {
      key: t.key, name: t.name, short: t.short, betterWhen: t.betterWhen, weekly: !!t.weekly,
      before: b.text, after: a ? a.text : '',
      ltrValues: !!b.ltr,
      beforePct: 100, afterPct: 0, delta: '', deltaAbs: '', gain: null
    };
    if (!a) return row;                        // edge case 1 — dashed after-bar

    var max = Math.max(b.v, a.v);
    row.beforePct = Math.round(b.v / max * 100);
    row.afterPct  = Math.round(a.v / max * 100);

    if (t.betterWhen === 'lower') {
      var faster = b.v - a.v;
      row.gain = b.v > 0 ? faster / b.v : 0;
      row.delta = faster > 0 ? ('מהיר ב־' + Math.round(row.gain * 100) + '%')
                             : ('איטי ב־' + Math.abs(Math.round(row.gain * 100)) + '%');
      row.deltaAbs = mmss(Math.abs(faster));
    } else {
      var up = a.v - b.v;
      row.gain = b.v > 0 ? up / b.v : 0;
      row.delta = (up >= 0 ? '+' : '') + Math.round(row.gain * 100) + '%';
      row.deltaAbs = (up >= 0 ? '+' : '') + trimNum(up) + (t.unit ? (' ' + t.unit) : '');
    }
    return row;
  }

  /* ---- attendance, streaks, RX ------------------------------------------ */
  function attendance(app) {
    var target = app.myTargetVal(), weeks = [], done = 0, best = 0, run = 0, full = 0, byDow = [0,0,0,0,0,0,0];
    for (var w = 0; w < 8; w++) {
      var c = 0;
      for (var d = 0; d < 7; d++) {
        var dd = app.state.data[w].days[d];
        if (app.dayComplete(dd)) { c++; run++; best = Math.max(best, run); byDow[d]++; }
        else run = 0;
      }
      c = Math.min(target, c);
      weeks.push(c); done += c;
      if (c >= target) full++;
    }
    return { weeks: weeks, done: done, of: target * 8, target: target, best: best, fullWeeks: full, byDow: byDow };
  }

  // Main metcon + metcon2 only, NO alt sessions — the app's own achievements
  // counter counts exactly these, and the badge on the card must never show a
  // bigger number than the athlete sees inside the app.
  function rxCount(app) {
    var n = 0;
    for (var w = 0; w < 8; w++) for (var d = 0; d < 7; d++) {
      var dd = app.state.data[w].days[d];
      [dd.metcon, dd.metcon2].forEach(function (m) {
        if (m && m.rx && app.metconScore(m)) n++;
      });
    }
    return n;
  }

  /* ---- personal records --------------------------------------------------
     Same rule the PR table already uses: heaviest LIFT weight per movement,
     movement name = the text before the ' — ' qualifier.                     */
  function personalRecords(app) {
    var best = {};
    for (var w = 0; w < 8; w++) for (var d = 0; d < 7; d++) {
      var dd = app.state.data[w].days[d];
      [dd, dd.alt].forEach(function (x) {
        if (!x || !x.lift) return;
        var name = (x.lift.movement || '').split('—')[0].trim();
        var wt = parseFloat(x.lift.log && x.lift.log.weight);
        if (!name || !(wt > 0)) return;
        var k = name.toLowerCase();
        if (!best[k] || wt > best[k].wt) best[k] = { name: name, wt: wt, pr: app.dayHasPR(x) };
      });
    }
    // A PR-flagged day wins the tie-break for the podium; otherwise heaviest.
    return Object.keys(best).map(function (k) { return best[k]; })
      .sort(function (x, y) { return (y.pr - x.pr) || (y.wt - x.wt); })
      .slice(0, 3)
      .map(function (e) { return { name: e.name, value: trimNum(e.wt) + ' ק"ג' }; });
  }

  /* ---- effort (v3): sessions the athlete rated "hard" ---------------------
     app.effortKey maps the v3 scale and the older numeric RPE alike.        */
  function hardCount(app) {
    var n = 0;
    for (var w = 0; w < 8; w++) for (var d = 0; d < 7; d++) {
      var dd = app.state.data[w].days[d];
      [dd, dd.alt].forEach(function (x) { if (x && x.done && app.effortKey && app.effortKey(x.rating) === 'hard') n++; });
    }
    return n;
  }

  /* ---- badges ------------------------------------------------------------
     Earned or absent. Nothing is handed out for showing up to the card.      */
  function badges(app, att, rx, tests, hard) {
    var out = [];
    if (att.best >= 5) out.push({ icon: '🔥', name: 'רצף ברזל', value: att.best + ' ימים רצופים' });
    if (rx >= 8) out.push({ icon: '⚡', name: 'RX ללא פשרות', value: rx + ' מטקונים בתקן' });
    if (att.fullWeeks >= 2) out.push({ icon: '💎', name: 'שבוע מושלם', value: att.fullWeeks + ' שבועות של ' + att.target + '/' + att.target });
    var improved = tests.filter(function (t) { return t.gain > 0; });
    if (improved.length && improved.length === tests.length) out.push({ icon: '📈', name: 'קו עולה', value: 'כל המבחנים השתפרו' });
    // v3 (Ori, 07/09): effort earns a badge too — the same threshold as the app's own "5 אימונים קשים" tag, and then some
    if (hard >= 8) out.push({ icon: '🥵', name: 'עבודה קשה', value: hard + ' אימונים במאמץ גבוה' });
    return out.slice(0, 3);
  }

  /* ---- keep / improve ----------------------------------------------------
     Every line is sourced from a number on the card. "improve" is written as
     a target for the next block — never as a verdict on this one.            */
  function keepList(app, att, rx, tests, goal) {
    var out = [];
    // v3 (Ori, 07/09): a goal the athlete marked reached leads the "keep" list
    if (goal && goal.text && goal.done) out.push({ title: 'המטרה הושגה 🎯', detail: goal.text });
    if (att.fullWeeks >= 2) out.push({ title: 'עקביות', detail: att.fullWeeks + ' שבועות מלאים מתוך 8' });
    var top = tests.filter(function (t) { return t.gain > 0; }).sort(function (a, b) { return b.gain - a.gain; })[0];
    if (top) {
      // deltaAbs carries its own sign for the chip; the sentence reads better without it
      var amount = String(top.deltaAbs).replace(/^\+/, '');
      out.push({ title: top.short, detail: top.name.split('—')[0].trim() + ' ' + (top.betterWhen === 'lower' ? 'ירד ב־' : 'עלה ב־') + amount });
    }
    if (rx >= 8) out.push({ title: 'משמעת RX', detail: rx + ' מטקונים בתקן המלא' });
    if (att.best >= 5) out.push({ title: 'רצף', detail: att.best + ' ימי אימון רצופים' });
    // Never leave the column as a bare heading: if nothing cleared a
    // threshold, the attendance count is still something true to keep.
    if (!out.length) out.push({ title: 'נוכחות', detail: att.done + ' אימונים מתוך ' + att.of });
    return out.slice(0, 3);
  }

  // app.weekdays is English (it labels the builder UI) — the card is Hebrew.
  var HE_DOW = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

  function improveList(app, att, tests, goal) {
    var out = [];
    // v3 (Ori, 07/09): a goal still open becomes the first target of the next block — never a verdict
    if (goal && goal.text && !goal.done) out.push({ title: 'המטרה ממשיכה 🎯', detail: goal.text });
    var measured = tests.filter(function (t) { return t.after; });
    var weakest = measured.slice().sort(function (a, b) { return a.gain - b.gain; })[0];
    if (weakest && measured.length > 1) out.push({ title: weakest.short, detail: 'שיפור של ' + weakest.deltaAbs + ' — הקטן מבין ' + measured.length + ' המבחנים' });
    var unmeasured = tests.filter(function (t) { return !t.after; });
    if (unmeasured.length) out.push({ title: 'לסגור מדידה', detail: unmeasured.length + ' מבחנים מחכים לרי-טסט' });
    // weakest weekday — the day the block kept losing
    var worst = -1, worstN = 99;
    att.byDow.forEach(function (n, d) { if (d < 5 && n < worstN) { worstN = n; worst = d; } });
    if (worst >= 0 && worstN < 8) out.push({ title: 'נוכחות ב' + HE_DOW[worst], detail: worstN + ' מתוך 8 שבועות' });
    // thinnest week — a concrete week to beat next block
    var lw = 0;
    att.weeks.forEach(function (n, w) { if (n < att.weeks[lw]) lw = w; });
    if (att.weeks[lw] < att.target) out.push({ title: 'השבוע החלש', detail: 'שבוע ' + (lw + 1) + ' — ' + att.weeks[lw] + ' מתוך ' + att.target });
    return out.slice(0, 3);
  }

  /* ======================================================================
     AVAILABILITY GATE — the card does not switch itself on.

     Ori's rule (29/08): the option opens only when he opens it, at the end
     of the program. Not when W8 is embedded, not when the last day is
     logged, not when the calendar passes the final date. Those are all
     tempting triggers and all of them are wrong — a block ends when the
     coach says it ended.

     The flag rides `shared_program` (id=1) — the same admin-published row
     the block announcement already uses, which every client re-reads on
     EVERY boot (boot.js fetchAnnouncement). One column, same convention:

       alter table public.shared_program
         add column if not exists block_recap jsonb;

       { "open": true, "opened_at": "2026-09-05T18:00:00.000Z" }

     Closed is every other state: null, column not created yet, fetch
     failed, open !== true. A gate that fails open is not a gate.

     Admins get 'preview' instead of 'closed' so Ori can look at his own
     card before he opens it to the roster — the UI must label that state,
     never render it as if it were live.
     ====================================================================== */
  function gateState(flag, isAdmin) {
    if (flag && flag.open === true) return 'open';
    return isAdmin ? 'preview' : 'closed';
  }
  function isOpen(flag) { return gateState(flag, false) === 'open'; }

  /* ---- the build ---------------------------------------------------------- */
  function build(app, opts) {
    opts = opts || {};
    var att = attendance(app);
    var rx = rxCount(app);
    var hard = hardCount(app);
    var goal = { text: String(app.state.myGoal || '').trim(), done: !!app.state.myGoalDone };
    var tests = testList().map(function (t) { return buildTest(app, t); }).filter(Boolean);
    var measured = tests.filter(function (t) { return t.after; });
    var improved = measured.filter(function (t) { return t.gain > 0; });

    var d0 = app.dateAt(0), d55 = app.dateAt(55);
    var fullDate = function (x) { return app.pad(x.getDate()) + '/' + app.pad(x.getMonth() + 1) + '/' + x.getFullYear(); };

    // hero — biggest relative gain among re-measured tests.
    // Edge case 2: fewer than 5 logged sessions in the whole block means there
    // is no honest headline number, so the hero counts sessions instead.
    var hero, thin = att.done < 5;
    var champ = improved.slice().sort(function (a, b) { return b.gain - a.gain; })[0];
    if (thin || !champ) {
      hero = { eyebrow: 'יומן אימונים', pct: String(att.done),
               lead: 'תועדו בבלוק', leadShort: 'תועדו',
               label: 'מתוך ' + att.of + ' מתוכננים', before: '', after: '' };
    } else {
      hero = { eyebrow: 'השיפור הגדול ביותר',
               pct: champ.betterWhen === 'lower' ? ('-' + Math.round(champ.gain * 100) + '%') : ('+' + Math.round(champ.gain * 100) + '%'),
               lead: 'הקפיצה של הבלוק', leadShort: 'הקפיצה של הבלוק',
               label: champ.name, before: champ.before, after: champ.after,
               unit: (testList().find(function (t) { return t.key === champ.key; }) || {}).unit || '' };
    }

    // Edge case 1: when not everything was re-measured the pill reports the
    // coverage instead of claiming a clean sweep — including "0 מתוך 4",
    // which is exactly what today's card says.
    var summary = tests.length === 0 ? ''
      : (measured.length === tests.length && improved.length === tests.length)
          ? ('✓ כל ' + tests.length + ' המבחנים השתפרו')
          : ('נמדדו שוב · ' + measured.length + ' מתוך ' + tests.length);

    return {
      logo: opts.logo || 'assets/logo.png',
      athlete: (app.state.myName || '').trim(),
      program: 'CAPACITY PROGRAM · 8 WEEKS',
      dateRange: fullDate(d0) + ' – ' + fullDate(d55),
      hero: hero,
      badges: thin ? [] : badges(app, att, rx, tests, hard),
      goal: goal, hard: hard,
      tests: tests,
      testsSummary: summary,
      attendance: { weeks: att.weeks, done: att.done, of: att.of, target: att.target },
      keep: keepList(app, att, rx, tests, goal),
      improve: improveList(app, att, tests, goal),
      prs: personalRecords(app),
      trackedPct: Math.round(att.done / att.of * 100) + '% מהבלוק תועד'
    };
  }

  global.BlockRecap = {
    build: build, get tests() { return testList(); },
    _slots: testSlots, _points: weeklyPoints,
    gateState: gateState, isOpen: isOpen,
    // v3 (07/09): the in-app tests screen (שיאים ומבחנים) reuses the same
    // rows the card draws — one config, one reader, one delta rule.
    _readSlot: readSlot, _mmss: mmss, _buildTest: buildTest
  };
})(typeof window !== 'undefined' ? window : this);
