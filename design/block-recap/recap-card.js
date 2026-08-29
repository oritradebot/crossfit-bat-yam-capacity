/* ==========================================================================
   Block Recap Share Card — renderer
   CrossFit Bat Yam · Capacity Tracker

   One renderer, two formats:
     story  1080x1920  (9:16)  — full card, includes the PR podium
     feed   1080x1350  (4:5)   — compact, no PRs, attendance on one line

   Both are authored at 1080 CSS px wide because that is Instagram's canvas
   width for EVERY format — what actually differs between the two is the
   height (and so the aspect). The PNG is then shot at scale 4/3 so the file
   lands at 1440 wide, which is Meta's 2026 advice for high-density screens:
     story -> 1440x2560      feed -> 1440x1800
   That sits in SIZES[f].exp. The capture reads it; the layout never moves.

   Colour: no single accent carries the card any more. Every place with a
   spectrum — attendance, test gains, the hero — is painted from ONE
   red -> amber -> green ramp built from the app's own semantic colours, so
   "more is greener" is true everywhere without a legend. The accent is
   reserved for the things that are not a measurement.

   Headings are Hebrew. Only the fixed names stay English: the gym, the
   program, the movements, RX.

   html2canvas constraints honoured: no backdrop-filter, no filter:blur, no
   masks, no mix-blend-mode. Linear gradients, radii, shadows and divs only.
   The graph is divs — no canvas, no chart library.
   ========================================================================== */
(function (global) {
  'use strict';
  var h = null;   // bound to React.createElement on first call

  var px = function (n) { return n + 'px'; };

  /* ---- the red -> green ramp ---------------------------------------------
     Stops are the tracker's own semantic colours (app.html: #E5564C missed,
     #E8A53A PR/amber, #3FBF6A done) with two blends between them, so the
     card speaks the same colour language as the app it comes out of.
     rampRGB(0) is red, rampRGB(1) is green, linear in between.              */
  var RAMP = [
    [0.00, [229,  86,  76]],   // #E5564C
    [0.25, [232, 123,  58]],   // #E87B3A
    [0.50, [232, 165,  58]],   // #E8A53A
    [0.75, [156, 201,  63]],   // #9CC93F
    [1.00, [ 63, 191, 106]]    // #3FBF6A
  ];
  function clamp01(t) { return !(t > 0) ? 0 : t > 1 ? 1 : t; }
  function rampRGB(t) {
    t = clamp01(t);
    for (var i = 1; i < RAMP.length; i++) {
      if (t <= RAMP[i][0]) {
        var a = RAMP[i - 1], b = RAMP[i], k = (t - a[0]) / (b[0] - a[0]);
        return [0, 1, 2].map(function (c) { return Math.round(a[1][c] + (b[1][c] - a[1][c]) * k); });
      }
    }
    return RAMP[RAMP.length - 1][1];
  }
  var rgb  = function (c) { return 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')'; };
  var rgba = function (c, a) { return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')'; };
  var ramp = function (t) { return rgb(rampRGB(t)); };

  /* A block gain of GAIN_FULL or better paints full green; flat or backwards
     paints red. 25% over eight weeks is already an excellent block — anchor
     the top of the ramp any higher and every honest result comes out amber. */
  var GAIN_FULL = 0.25;
  var gainTone = function (g) { return clamp01((g || 0) / GAIN_FULL); };

  /* ---- accent --------------------------------------------------------------
     NOT a measurement colour — it means "this is a section marker". It paints
     every section heading, plus the hero chip frame, the next-block bullets
     and the footer line. Nothing it touches carries a value.

     It has to do that job because the headings turned Hebrew: in Latin caps
     the letter-spacing was what said "I am a label", and dropping it left
     `נוכחות` identical to the dim hint line directly beneath it. Something
     has to separate label from caption now.

     Ori's call (29/08): plain WHITE. It is the strongest thing on a navy card,
     it still clears the dim caption underneath by a mile, and — unlike any hue
     — it cannot be mistaken for a position on the ramp. The coloured options
     stay in the table; swap with BlockRecapCard.setAccent(...) if that changes.
     The old #EF5B25 orange is gone — it landed mid-ramp and read like one.

     The colour system, one job each:
       ramp (red->green) = measurements   ·  gold = achievements
       accent            = section labels ·  white = content  ·  dim = detail  */
  var ACCENTS = {
    white:  { label: 'לבן',    rgb: [255, 255, 255] },
    teal:   { label: 'טורקיז', rgb: [ 63, 184, 207] },
    sky:    { label: 'תכלת',   rgb: [ 91, 155, 240] },
    violet: { label: 'סגול',   rgb: [155, 124, 240] },
    gold:   { label: 'זהב',    rgb: [240, 192, 100] }
  };
  var ACCENT_DEFAULT = 'white';

  /* ---- design tokens ------------------------------------------------------- */
  var T = {
    bg:      'linear-gradient(150deg,#0F1830,#1A2848 55%,#23409A)',
    /* the top strip IS the legend: red at the start edge (right, RTL) and
       green at the end, so the ramp is stated once and never explained. */
    topbar:  'linear-gradient(270deg,#E5564C,#E8A53A 50%,#3FBF6A)',
    gold:    '#F0C064',
    green:   '#3FBF6A',
    ink:     '#FFFFFF',
    sub:     '#B9C4E6',
    dim:     '#8FA4D8',
    row:     'rgba(255,255,255,.08)',
    track:   'rgba(255,255,255,.10)',
    before:  'rgba(143,164,216,.65)',
    badgeBg: 'rgba(240,192,100,.10)',
    badgeBd: '1.5px solid rgba(240,192,100,.35)',
    sep:     '1px solid rgba(255,255,255,.15)',
    /* Heebo is named as Oswald's fallback on purpose: the value strings are
       mixed ("+15 ק\"ג", "מהיר ב־13%"), and Oswald has no Hebrew glyphs. Without
       it the Hebrew half falls through to whatever default sans the browser
       picks — which is not the face html2canvas would shoot. Latin digits
       still come from Oswald; only the Hebrew drops to Heebo. */
    osw:     "'Oswald','Heebo',sans-serif",
    heb:     "'Heebo',sans-serif",
    accent: '', accentSoft: '', accentLine: '', accentName: ''
  };
  function setAccent(key) {
    var name = ACCENTS[key] ? key : ACCENT_DEFAULT, a = ACCENTS[name];
    T.accent     = rgb(a.rgb);
    T.accentSoft = rgba(a.rgb, .16);
    T.accentLine = rgba(a.rgb, .55);
    T.accentName = name;
    return name;
  }
  setAccent(ACCENT_DEFAULT);

  /* ---- Hebrew headings -----------------------------------------------------
     Oswald carries no Hebrew glyphs, so every heading that turned Hebrew has
     to leave it — otherwise the browser silently falls back and html2canvas
     shoots a different face than the preview showed. Letter-spacing goes with
     it: it is a Latin-caps device and it pulls Hebrew word shapes apart.
     Oswald stays exactly where it still belongs — on numerals, and on the
     fixed English names (the gym, the program, the movements, RX).           */
  function hebHead(size, weight, extra) {
    var s = { fontFamily: T.heb, fontWeight: weight || 700, fontSize: px(size), letterSpacing: 'normal' };
    if (extra) Object.keys(extra).forEach(function (k) { s[k] = extra[k]; });
    return s;
  }

  /* ---- per-format size table -----------------------------------------------
     Every number below is lifted from the handoff HTML. The two cards share
     one language; the feed is its compressed voice. Nothing is derived —
     the reference files are the source of truth, so the table stays explicit
     and greppable.                                                            */
  var SIZES = {
    story: {
      w: 1080, hgt: 1920, ratio: '9:16', pad: '44px 64px 40px',
      exp: { w: 1440, h: 2560, scale: 4 / 3 },
      logo: 96, ring: 5, hGap: 22, brand: 40, prog: 24, aLbl: 22, aName: 36,
      inlineHero: false,
      title: 56, tDate: 29,
      eyebrow: 24, rule: 120, hero: 150, heroGlowR: 90, heroGlowA: .5,
      heroDesc: 28, heroChip: 23, heroChipPad: '5px 18px', heroArrow: 26, heroChipGap: 12, heroUnit: true,
      bLbl: 22, bLblMb: 10, bGap: 16, bRad: 20, bPad: '12px 18px', bIcoGap: 14, bIco: 34, bName: 23, bVal: 20,
      gPad: 18, gHead: 31, gCap: 23, gPill: 21, gPillPad: '4px 16px', gHeadMb: 12, gRowGap: 12,
      rRad: 22, rPad: '13px 26px', rName: 28, rChip: 23, rChipPad: '4px 16px', rTag: 19, rTagPad: '2px 13px',
      barLbl: 46, barLblF: 20, barH: 14, barR: 8, barGap: 6, barRowGap: 14, barMt: 10,
      valW: 120, valBefore: 22, valAfter: 25,
      aLblF: 22, aBig: 34, aBigTxt: 26, aHint: 22, aColGap: 12, aColW: 52, aBarH: 11, aBarR: 3, aBarGap: 4, aNum: 20,
      lGap: 44, lHead: 30, lSub: 21, lItemGap: 10, lMark: 32, lMarkF: 18, lTitle: 26, lDetail: 22, lInline: false,
      prHead: 29, prGap: 16, prRad: 20, prPad: '13px 22px', prName: 24, prVal: 32,
      fPad: 16, fLbl: 28, fDate: 24, fTracked: 21, fStack: true,
      showPRs: true,
      /* 4+ tests overflow the fixed height at the sizes above — the handoff
         card is drawn for exactly 3. `dense` buys back the ~124px a fourth
         CapaciTest costs, taken out of the graph rows and the two lists so
         the header, hero and PR podium keep their weight. */
      dense: { rPad: '8px 24px', rName: 25, rChip: 21, rChipPad: '3px 14px', rTag: 18,
               barMt: 7, barGap: 4, valBefore: 20, valAfter: 22, gRowGap: 9, gHeadMb: 10,
               lTitle: 25, lDetail: 21 }
    },
    feed: {
      w: 1080, hgt: 1350, ratio: '4:5', pad: '48px 56px 44px',
      exp: { w: 1440, h: 1800, scale: 4 / 3 },
      logo: 84, ring: 4, hGap: 20, brand: 36, prog: 23, aLbl: 21, aName: 33,
      inlineHero: true,
      title: 46, tDate: 26,
      eyebrow: 0, rule: 0, hero: 100, heroGlowR: 60, heroGlowA: .45,
      heroDesc: 23, heroChip: 20, heroChipPad: '3px 14px', heroArrow: 22, heroChipGap: 10, heroUnit: false,
      bLbl: 19, bLblMb: 8, bGap: 12, bRad: 16, bPad: '10px 14px', bIcoGap: 12, bIco: 28, bName: 21, bVal: 18,
      gPad: 20, gHead: 27, gCap: 21, gPill: 19, gPillPad: '3px 14px', gHeadMb: 10, gRowGap: 9,
      rRad: 18, rPad: '11px 22px', rName: 25, rChip: 21, rChipPad: '3px 14px', rTag: 18, rTagPad: '2px 12px',
      barLbl: 42, barLblF: 19, barH: 13, barR: 6.5, barGap: 5, barRowGap: 12, barMt: 8,
      valW: 106, valBefore: 20, valAfter: 22,
      aLblF: 20, aBig: 27, aBigTxt: 23, aHint: 0, aColGap: 8, aColW: 36, aBarH: 6, aBarR: 2, aBarGap: 3, aNum: 0,
      lGap: 40, lHead: 27, lSub: 19, lItemGap: 10, lMark: 26, lMarkF: 14, lTitle: 22, lDetail: 22, lInline: true,
      prHead: 0, prGap: 0, prRad: 18, prPad: '11px 22px', prName: 22, prVal: 0,
      fPad: 18, fLbl: 25, fDate: 22, fTracked: 19, fStack: false,
      showPRs: false,
      dense: { rPad: '8px 20px', rName: 23, barMt: 6, barGap: 4,
               valBefore: 19, valAfter: 20, gRowGap: 8 }
    }
  };

  var ltr = function (txt, extra) { return h('span', { dir: 'ltr', style: extra || undefined }, txt); };

  /* ---- where each spectrum reads its position from -------------------------
     All three derive from data already on the card, so a fixture never has to
     hand-tune a colour. An explicit `tone` on the data overrides.             */
  function heroTone(d) {
    if (typeof d.hero.tone === 'number') return d.hero.tone;
    var best = (d.tests || []).reduce(function (m, t) { return t.after ? Math.max(m, t.gain || 0) : m; }, 0);
    if (best > 0) return gainTone(best);
    var a = d.attendance;                       // thin-log hero counts sessions
    return (a && a.of) ? a.done / a.of : 0;
  }
  function testsTone(d) {
    if (typeof d.testsTone === 'number') return d.testsTone;
    var ts = d.tests || [];
    if (!ts.length) return 0;
    return ts.filter(function (t) { return t.after && (t.gain || 0) > 0; }).length / ts.length;
  }

  /* ---- section: header -------------------------------------------------- */
  function headerEl(d, S) {
    return h('div', { key: 'head', style: { display: 'flex', alignItems: 'center', gap: px(S.hGap) } },
      h('img', { src: d.logo || 'logo.png', alt: 'CrossFit Bat Yam',
        style: { width: px(S.logo), height: px(S.logo), borderRadius: '50%',
                 boxShadow: '0 0 0 ' + px(S.ring) + ' rgba(255,255,255,.25)', flex: 'none' } }),
      h('div', { style: { flex: 1, minWidth: 0 } },
        h('div', { style: { fontFamily: T.osw, fontWeight: 700, fontSize: px(S.brand), lineHeight: 1.2, letterSpacing: '.06em' } }, 'CROSSFIT BAT YAM'),
        h('div', { style: { fontSize: px(S.prog), lineHeight: 1.3, color: T.sub } }, d.program)
      ),
      d.athlete ? h('div', { style: { textAlign: 'end', flex: 'none' } },
        h('div', { style: hebHead(S.aLbl, 600, { color: T.dim, lineHeight: 1.3 }) }, 'מתאמן/ת'),
        h('div', { dir: 'auto', style: { fontWeight: 700, fontSize: px(S.aName) } }, d.athlete)
      ) : null
    );
  }

  /* ---- section: hero -----------------------------------------------------
     Edge case 2 (handoff): under 5 logged sessions there is no honest
     "biggest gain" to show, so the hero becomes a training-log count instead
     of an improvement percentage. Show less, never invent. The data builder
     decides — this renderer just draws whatever hero it is handed, and paints
     it at its place on the ramp.                                            */
  function heroChipsEl(d, S, align, c) {
    var hero = d.hero, unit = (S.heroUnit && hero.unit) ? (' ' + hero.unit) : '';
    return h('div', { style: { display: 'flex', justifyContent: align, alignItems: 'center', gap: px(S.heroChipGap), marginTop: S.inlineHero ? '8px' : '12px' } },
      h('span', { style: { border: '1.5px solid rgba(255,255,255,.22)', color: T.sub, borderRadius: '999px', padding: S.heroChipPad, fontSize: px(S.heroChip), lineHeight: 1.3 } },
        'שבוע 1 · ', h('span', { style: { fontFamily: T.osw, fontWeight: 600, color: T.ink } }, hero.before), unit),
      h('span', { style: { color: T.dim, fontSize: px(S.heroArrow) } }, '←'),
      h('span', { style: { background: rgba(c, .16), border: '1.5px solid ' + rgba(c, .55), color: T.ink, borderRadius: '999px', padding: S.heroChipPad, fontSize: px(S.heroChip), lineHeight: 1.3 } },
        'שבוע 8 · ', h('span', { style: { fontFamily: T.osw, fontWeight: 700, color: rgb(c) } }, hero.after), unit)
    );
  }

  function heroNumStyle(S, c) {
    return { fontFamily: T.osw, fontWeight: 700, fontSize: px(S.hero), lineHeight: S.inlineHero ? 1 : 1.05,
             color: rgb(c), textShadow: '0 0 ' + px(S.heroGlowR) + ' ' + rgba(c, S.heroGlowA) };
  }

  function heroStoryEl(d, S) {
    var hero = d.hero, c = rampRGB(heroTone(d));
    var rule = function (deg, k) {
      return h('span', { key: k, style: { width: px(S.rule), height: '1.5px', background: 'linear-gradient(' + deg + 'deg,rgba(240,192,100,.55),rgba(240,192,100,0))' } });
    };
    return [
      h('div', { key: 'title', style: { display: 'flex', alignItems: 'baseline', gap: '20px' } },
        h('span', { style: hebHead(S.title, 800, { lineHeight: 1.1 }) }, 'הבלוק הושלם'),
        ltr(d.dateRange, { fontSize: px(S.tDate), color: T.sub })
      ),
      h('div', { key: 'hero', style: { textAlign: 'center' } },
        h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '18px' } },
          rule(270, 'a'),
          h('span', { key: 'e', style: hebHead(S.eyebrow, 700, { lineHeight: 1.3, color: T.gold }) }, hero.eyebrow || 'השיפור הגדול ביותר'),
          rule(90, 'b')
        ),
        h('div', { dir: 'ltr', style: heroNumStyle(S, c) }, hero.pct),
        h('div', { style: { fontSize: px(S.heroDesc), lineHeight: 1.3, color: T.sub } },
          (hero.lead || 'הקפיצה של הבלוק') + ' · ',
          h('span', { style: { color: T.ink, fontWeight: 700 } }, hero.label)),
        hero.before ? heroChipsEl(d, S, 'center', c) : null
      )
    ];
  }

  function heroFeedEl(d, S) {
    var hero = d.hero, c = rampRGB(heroTone(d));
    return h('div', { key: 'hero', style: { display: 'flex', alignItems: 'center', gap: '24px' } },
      h('div', { style: { flex: 1, minWidth: 0 } },
        h('div', { style: hebHead(S.title, 800, { lineHeight: 1.1 }) }, 'הבלוק הושלם'),
        h('div', { dir: 'ltr', style: { fontSize: px(S.tDate), color: T.sub, textAlign: 'end' } }, d.dateRange)
      ),
      h('div', { style: { flex: 'none', textAlign: 'end' } },
        h('div', { dir: 'ltr', style: heroNumStyle(S, c) }, hero.pct),
        h('div', { style: { fontSize: px(S.heroDesc), color: T.sub, marginTop: '2px' } },
          (hero.leadShort || 'הקפיצה של הבלוק') + ' · ',
          h('span', { style: { color: T.ink, fontWeight: 700 } }, hero.label)),
        hero.before ? heroChipsEl(d, S, 'flex-end', c) : null
      )
    );
  }

  /* ---- section: badges --------------------------------------------------- */
  function badgesEl(d, S) {
    if (!d.badges || !d.badges.length) return null;
    return h('div', { key: 'badges' },
      h('div', { style: hebHead(S.bLbl, 700, { lineHeight: 1.2, color: T.accent, marginBottom: px(S.bLblMb) }) }, '🏅 הישגים שנפתחו'),
      h('div', { style: { display: 'flex', gap: px(S.bGap) } },
        d.badges.map(function (b, i) {
          return h('div', { key: i, style: { flex: 1, background: T.badgeBg, border: T.badgeBd, borderRadius: px(S.bRad), padding: S.bPad, display: 'flex', alignItems: 'center', gap: px(S.bIcoGap) } },
            h('span', { style: { fontSize: px(S.bIco), lineHeight: 1 } }, b.icon),
            h('div', { style: { flex: 1, minWidth: 0 } },
              h('div', { style: { fontWeight: 700, fontSize: px(S.bName), lineHeight: 1.25 } }, b.name),
              h('div', { style: { fontSize: px(S.bVal), fontWeight: 600, color: T.gold, lineHeight: 1.3 } }, b.value))
          );
        })
      )
    );
  }

  /* ---- section: שבוע 1 -> שבוע 8 graph ------------------------------------
     Two bars per test, width = value / max(before, after). On a timed test
     the slower time is the 100% bar, so "shorter is better" reads correctly
     without inverting the scale. The "after" bar and its delta chip are
     painted at the test's own place on the ramp, so a 4% nudge and a 40%
     jump never look alike.
     Edge case 1: a test with no retest draws a dashed empty "after" bar,
     prints "לא נמדד", and swaps the delta chip for a muted note — no colour
     at all, because there is no measurement to colour.                       */
  function bar(S, pct, opts) {
    var fill = opts.dashed
      ? h('div', { style: { width: '100%', height: px(S.barH), borderRadius: px(S.barR), border: '1.5px dashed rgba(255,255,255,.28)', boxSizing: 'border-box' } })
      : h('div', { style: { width: Math.max(0, Math.min(100, pct || 0)) + '%', height: px(S.barH), borderRadius: px(S.barR), background: opts.color } });
    return h('div', { key: opts.label, style: { display: 'flex', alignItems: 'center', gap: px(S.barRowGap) } },
      h('span', { style: { flex: 'none', width: px(S.barLbl), fontWeight: 600, fontSize: px(S.barLblF), lineHeight: 1.2, color: T.dim } }, opts.label),
      h('div', { style: { flex: 1, height: px(S.barH), borderRadius: px(S.barR), background: T.track } }, fill),
      h('span', { dir: opts.ltr ? 'ltr' : undefined,
        style: { flex: 'none', minWidth: px(S.valW), fontWeight: opts.strong ? 700 : 600, fontSize: px(opts.strong ? S.valAfter : S.valBefore), lineHeight: 1.2, color: opts.muted ? T.dim : T.ink, textAlign: opts.ltr ? 'start' : undefined } }, opts.value)
    );
  }

  function testRowEl(t, S, i) {
    var missing = !t.after, c = rampRGB(gainTone(t.gain));
    var chip = missing
      ? h('div', { key: 'c', style: { flex: 'none', border: '1px solid rgba(255,255,255,.18)', color: T.dim, borderRadius: '999px', padding: S.rTagPad, fontSize: px(S.rTag), lineHeight: 1.3 } }, 'נמדד בשבוע 1 בלבד')
      : h('div', { key: 'c', style: { flex: 'none', background: rgba(c, .14), color: rgb(c), borderRadius: '999px', padding: S.rChipPad, fontFamily: T.osw, fontWeight: 600, fontSize: px(S.rChip), lineHeight: 1.25, display: 'flex', alignItems: 'baseline', gap: '7px' } },
          ltr(t.delta),
          t.deltaAbs ? h('span', { style: { opacity: .8 } }, '· ', ltr(t.deltaAbs)) : null);
    var lowerTag = t.betterWhen === 'lower'
      ? h('div', { key: 'lt', style: { flex: 'none', border: '1px solid rgba(255,255,255,.20)', color: T.sub, borderRadius: '999px', padding: S.rTagPad, fontSize: px(S.rTag), lineHeight: 1.3 } }, 'קצר יותר = טוב')
      : null;
    return h('div', { key: i, style: { background: T.row, borderRadius: px(S.rRad), padding: S.rPad } },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: px(S.barRowGap) } },
        h('div', { key: 'n', style: { flex: lowerTag ? '0 1 auto' : 1, minWidth: 0, fontWeight: 700, fontSize: px(S.rName), lineHeight: 1.3 } }, t.name),
        lowerTag,
        lowerTag ? h('div', { key: 'sp', style: { flex: 1 } }) : null,
        chip
      ),
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: px(S.barGap), marginTop: px(S.barMt) } },
        bar(S, t.beforePct, { label: 'לפני', color: T.before, value: t.before, muted: true, ltr: t.ltrValues }),
        bar(S, t.afterPct, { label: 'אחרי', color: rgb(c), value: missing ? 'לא נמדד' : t.after, strong: !missing, muted: missing, dashed: missing, ltr: t.ltrValues && !missing })
      )
    );
  }

  function graphEl(d, S) {
    if (!d.tests || !d.tests.length) return null;
    var n = d.tests.length, words = { 2: 'שני', 3: 'שלושה', 4: 'ארבעה', 5: 'חמישה' };
    var pc = rampRGB(testsTone(d));
    return h('div', { key: 'graph', style: { borderTop: T.sep, paddingTop: px(S.gPad) } },
      h('div', { style: { display: 'flex', alignItems: 'baseline', gap: px(S.barRowGap), marginBottom: px(S.gHeadMb) } },
        h('span', { key: 'hd', style: hebHead(S.gHead, 800, { lineHeight: 1.2, color: T.accent }) }, 'שבוע 1 ← שבוע 8'),
        h('span', { key: 'cap', style: { fontSize: px(S.gCap), color: T.dim } }, 'לפני מול אחרי · ' + (words[n] || n) + ' מבחנים'),
        h('span', { key: 'sp', style: { flex: 1 } }),
        d.testsSummary ? h('span', { key: 'pill', style: { background: rgba(pc, .14), color: rgb(pc), borderRadius: '999px', padding: S.gPillPad, fontWeight: 700, fontSize: px(S.gPill), lineHeight: 1.3 } }, d.testsSummary) : null
      ),
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: px(S.gRowGap) } },
        d.tests.map(function (t, i) { return testRowEl(t, S, i); })
      )
    );
  }

  /* ---- section: attendance -----------------------------------------------
     One column per week, one bar per completed session against the weekly
     target, each column painted at its own fill ratio: a 2/5 week is red, a
     5/5 week is green. The grid stays the honest picture — the gaps are still
     visible, they are just legible at a glance now.                          */
  function attColsEl(a, S) {
    var target = a.target || 5;
    return h('div', { key: 'cols', style: { flex: 'none', display: 'flex', gap: px(S.aColGap) } },
      a.weeks.map(function (n, wi) {
        var col = ramp(target ? n / target : 0), bars = [];
        for (var i = 0; i < target; i++) {
          bars.push(h('div', { key: i, style: { height: px(S.aBarH), borderRadius: px(S.aBarR), background: i < (target - n) ? 'rgba(255,255,255,.13)' : col } }));
        }
        if (S.aNum) bars.push(h('div', { key: 'n', style: { textAlign: 'center', fontFamily: T.osw, fontSize: px(S.aNum), color: T.dim, marginTop: '4px' } }, String(wi + 1)));
        return h('div', { key: wi, style: { width: px(S.aColW), display: 'flex', flexDirection: 'column', gap: px(S.aBarGap) } }, bars);
      })
    );
  }

  function attendanceEl(d, S) {
    var a = d.attendance;
    if (!a) return null;
    var big = ramp(a.of ? a.done / a.of : 0);
    if (S.inlineHero) {   // feed — one line
      return h('div', { key: 'att', style: { borderTop: T.sep, paddingTop: '18px', display: 'flex', alignItems: 'center', gap: '24px' } },
        h('div', { key: 'txt', style: { flex: 1, minWidth: 0, fontSize: px(S.aBigTxt) } },
          h('span', { style: hebHead(S.aLblF, 700, { color: T.accent }) }, 'נוכחות'),
          '  ',
          ltr(a.done + ' / ' + a.of, { fontFamily: T.osw, fontWeight: 700, fontSize: px(S.aBig), color: big }),
          ' ', h('span', { style: { fontWeight: 600 } }, 'אימונים')),
        attColsEl(a, S)
      );
    }
    return h('div', { key: 'att', style: { borderTop: T.sep, paddingTop: '18px', display: 'flex', alignItems: 'center', gap: '32px' } },
      h('div', { key: 'txt', style: { flex: 1, minWidth: 0 } },
        h('div', { style: hebHead(S.aLblF, 700, { lineHeight: 1.2, color: T.accent }) }, 'נוכחות'),
        h('div', { style: { fontSize: px(S.aBigTxt), lineHeight: 1.3, marginTop: '4px' } },
          ltr(a.done + ' / ' + a.of, { fontFamily: T.osw, fontWeight: 700, fontSize: px(S.aBig), color: big }),
          ' ', h('span', { style: { fontWeight: 600 } }, 'אימונים הושלמו')),
        h('div', { style: { fontSize: px(S.aHint), lineHeight: 1.3, color: T.dim, marginTop: '2px' } }, 'כל עמודה = שבוע · כל פס = אימון שהושלם')
      ),
      attColsEl(a, S)
    );
  }

  /* ---- section: keep / improve -------------------------------------------
     "improve" is always phrased as a target for the next block, never as a
     failure in this one — which is exactly why its bullet takes the accent
     and not the ramp's red end. What worked is green; what is next is accent. */
  function listEl(items, S, opts) {
    return h('div', { key: opts.key, style: { flex: 1, minWidth: 0 } },
      h('div', { style: { fontWeight: 800, fontSize: px(S.lHead), lineHeight: 1.25, color: T.accent } }, opts.head),
      h('div', { style: { fontSize: px(S.lSub), color: T.dim, lineHeight: 1.3, marginTop: S.lInline ? '1px' : '2px' } }, opts.sub),
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: px(S.lItemGap), marginTop: '12px' } },
        items.map(function (it, i) {
          var mark = h('span', { key: 'm', style: { flex: 'none', width: px(S.lMark), height: px(S.lMark), borderRadius: '50%', border: '2px solid ' + opts.markBd, color: opts.markCol, fontSize: px(S.lMarkF), lineHeight: px(S.lMark - 4), textAlign: 'center', boxSizing: 'border-box', marginTop: '2px' } }, opts.mark);
          var body = S.lInline
            ? h('div', { key: 'b', style: { flex: 1, minWidth: 0 } },
                h('span', { style: { fontWeight: 700 } }, it.title), ' ',
                h('span', { style: { color: T.sub } }, '— ' + it.detail))
            : h('div', { key: 'b', style: { flex: 1, minWidth: 0 } },
                h('div', { style: { fontWeight: 700, fontSize: px(S.lTitle), lineHeight: 1.3 } }, it.title),
                h('div', { style: { fontSize: px(S.lDetail), color: T.sub, lineHeight: 1.35 } }, it.detail));
          return h('div', { key: i, style: S.lInline
            ? { display: 'flex', gap: '10px', alignItems: 'flex-start', fontSize: px(S.lTitle), lineHeight: 1.35 }
            : { display: 'flex', gap: '12px', alignItems: 'flex-start' } }, mark, body);
        })
      )
    );
  }

  function listsEl(d, S) {
    if (!(d.keep && d.keep.length) && !(d.improve && d.improve.length)) return null;
    return h('div', { key: 'lists', style: { borderTop: T.sep, paddingTop: '18px', display: 'flex', gap: px(S.lGap) } },
      listEl(d.keep || [], S, { key: 'keep', head: '✅ נקודות לשימור', sub: 'מה שעבד — ממשיכים', mark: '✓', markBd: 'rgba(63,191,106,.55)', markCol: T.green }),
      listEl(d.improve || [], S, { key: 'imp', head: '🎯 נקודות לחיזוק', sub: 'היעדים לבלוק הבא', mark: '↑', markBd: T.accentLine, markCol: T.accent })
    );
  }

  /* ---- section: personal records (story only) -----------------------------
     Edge case 3: no PRs -> one quiet dashed line, no trophy, no gold.         */
  function prsEl(d, S) {
    if (!S.showPRs) return null;
    var prs = d.prs || [];
    if (!prs.length) {
      return h('div', { key: 'prs', style: { borderTop: T.sep, paddingTop: '18px' } },
        h('div', { style: { border: '1.5px dashed rgba(255,255,255,.22)', borderRadius: px(S.prRad), padding: S.prPad, textAlign: 'center', color: T.dim, fontSize: px(S.prName), lineHeight: 1.4 } },
          'לא נרשמו שיאים חדשים בבלוק הזה')
      );
    }
    return h('div', { key: 'prs', style: { borderTop: T.sep, paddingTop: '18px' } },
      h('div', { style: hebHead(S.prHead, 800, { lineHeight: 1.25, color: T.accent }) }, '🏆 שיאים אישיים'),
      h('div', { style: { display: 'flex', gap: px(S.prGap), marginTop: '16px' } },
        prs.slice(0, 3).map(function (p, i) {
          return h('div', { key: i, style: { flex: 1, background: T.row, borderRadius: px(S.prRad), padding: S.prPad } },
            h('div', { style: { fontWeight: 700, fontSize: px(S.prName), lineHeight: 1.25 } }, p.name),
            h('div', { style: { fontFamily: T.osw, fontWeight: 700, fontSize: px(S.prVal), lineHeight: 1.15, color: T.gold, marginTop: '2px' } }, p.value));
        })
      )
    );
  }

  /* ---- section: footer ----------------------------------------------------- */
  function footerEl(d, S) {
    var right = S.fStack
      ? h('div', { key: 'r', style: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '2px' } },
          ltr(d.dateRange, { fontSize: px(S.fDate), color: T.sub }),
          h('span', { key: 't', style: { fontSize: px(S.fTracked), color: T.dim } }, d.trackedPct))
      : h('div', { key: 'r', style: { display: 'flex', alignItems: 'baseline', gap: '16px' } },
          h('span', { key: 't', style: { fontSize: px(S.fTracked), color: T.dim } }, d.trackedPct),
          ltr(d.dateRange, { fontSize: px(S.fDate), color: T.sub }));
    return h('div', { key: 'foot', style: { borderTop: T.sep, paddingTop: px(S.fPad), display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
      h('span', { key: 'l', style: hebHead(S.fLbl, 700, { color: T.accent }) }, 'חזקים יותר בכל שבוע'),
      right
    );
  }

  /* ---- the card ------------------------------------------------------------ */
  function recapCardEl(d, format, domId) {
    h = (global.React || {}).createElement;
    if (!h) throw new Error('recap-card: React is not loaded');
    var base = SIZES[format] || SIZES.story, S = base;
    if (((d.tests || []).length >= 4) && base.dense) {
      S = {}; Object.keys(base).forEach(function (k) { S[k] = base[k]; });
      Object.keys(base.dense).forEach(function (k) { S[k] = base.dense[k]; });
    }
    var sections = [headerEl(d, S)]
      .concat(S.inlineHero ? [heroFeedEl(d, S)] : heroStoryEl(d, S))
      .concat([badgesEl(d, S), graphEl(d, S), attendanceEl(d, S), listsEl(d, S), prsEl(d, S), footerEl(d, S)])
      .filter(Boolean);
    return h('div', {
      id: domId || ('recap-card-' + format), dir: 'rtl',
      style: {
        width: px(S.w), height: px(S.hgt), position: 'relative', overflow: 'hidden',
        background: T.bg, color: T.ink, padding: S.pad, boxSizing: 'border-box',
        display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
        fontFamily: T.heb
      }
    }, h('div', { key: 'topbar', style: { position: 'absolute', top: 0, left: 0, right: 0, height: '6px', background: T.topbar } }), sections);
  }

  global.BlockRecapCard = {
    el: recapCardEl, tokens: T, sizes: SIZES,
    accents: ACCENTS, setAccent: setAccent,
    ramp: ramp, rampRGB: rampRGB, gainTone: gainTone
  };
})(typeof window !== 'undefined' ? window : this);
