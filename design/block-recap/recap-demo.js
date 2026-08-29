/* ==========================================================================
   Block Recap Share Card — demo datasets (preview only, never shipped)

   Three fixtures, each the exact shape recap-build.js returns:
     reference  the handoff's own numbers — the pixel-fidelity check
     batyam     the real Capacity block: 4 CapaciTests, real dates and names
     edge       the quiet card — no retests, no PRs, thin log
   ========================================================================== */
(function (global) {
  'use strict';

  var DEMO = {};

  /* ---- A. the handoff reference (3 tests) ------------------------------- */
  DEMO.reference = {
    logo: 'logo.png',
    athlete: 'דנה לוי',
    program: 'CAPACITY PROGRAM · 8 WEEKS',
    dateRange: '12/07/2026 – 05/09/2026',
    hero: { eyebrow: 'השיפור הגדול ביותר', pct: '+60%', lead: 'הקפיצה של הבלוק', leadShort: 'הקפיצה של הבלוק',
            label: 'C2B/Pull Ups — חזרות לדקה', before: '5', after: '8', unit: 'לדקה' },
    badges: [
      { icon: '🔥', name: 'רצף ברזל', value: '9 ימים רצופים' },
      { icon: '⚡', name: 'RX ללא פשרות', value: '14 מטקונים בתקן' },
      { icon: '💎', name: 'שבוע מושלם', value: '4 שבועות של 5/5' }
    ],
    tests: [
      { name: 'Back Squat — שלשה כבדה', short: 'כוח רגליים', before: '85 ק"ג', after: '100 ק"ג',
        beforePct: 85, afterPct: 100, delta: '+18%', deltaAbs: '+15 ק"ג', betterWhen: 'higher', gain: .18 },
      { name: 'מבחן אירובי — 3 סבבים', short: 'סיבולת אירובית', before: '18:42', after: '16:05', ltrValues: true,
        beforePct: 100, afterPct: 86, delta: 'מהיר ב־14%', deltaAbs: '2:37', betterWhen: 'lower', gain: .14 },
      { name: 'C2B/Pull Ups — חזרות לדקה', short: "ג'ימנסטיקה", before: '5', after: '8',
        beforePct: 63, afterPct: 100, delta: '+60%', deltaAbs: '+3 בדקה', betterWhen: 'higher', gain: .60 }
    ],
    testsSummary: '✓ כל 3 המבחנים השתפרו',
    attendance: { weeks: [4,5,3,5,4,2,5,3], done: 31, of: 40, target: 5 },
    keep: [
      { title: 'עקביות',   detail: '4 שבועות מלאים מתוך 8' },
      { title: 'כוח רגליים', detail: 'סקוואט עלה ב־15 ק"ג' },
      { title: 'משמעת RX',  detail: '14 מטקונים בתקן המלא' }
    ],
    improve: [
      { title: 'סיבולת אירובית', detail: 'שיפור של 2:37 — הכי קטן מבין השלושה' },
      { title: 'נוכחות בשישי',   detail: '3 מתוך 8 שבועות' },
      { title: "ג'ימנסטיקה",     detail: 'C2B עדיין נשבר אחרי הדקה השישית' }
    ],
    prs: [
      { name: 'Back Squat',   value: '100 ק"ג' },
      { name: 'Clean & Jerk', value: '72 ק"ג' },
      { name: 'Deadlift',     value: '130 ק"ג' }
    ],
    trackedPct: '78% מהבלוק תועד'
  };

  /* ---- B. the real block — CrossFit Bat Yam, 12/07–05/09/2026 -----------
     All four CapaciTests the program actually runs, in program order, with
     the values a mid-pack athlete plausibly logs. This is the target output:
     what the card renders once W8 retests are embedded and logged.          */
  DEMO.batyam = {
    logo: 'logo.png',
    athlete: 'אורי עוזל',
    program: 'CAPACITY PROGRAM · 8 WEEKS',
    dateRange: '12/07/2026 – 05/09/2026',
    hero: { eyebrow: 'השיפור הגדול ביותר', pct: '+50%', lead: 'הקפיצה של הבלוק', leadShort: 'הקפיצה של הבלוק',
            label: 'C2B/Pull Ups — חזרות לדקה', before: '6', after: '9', unit: 'לדקה' },
    badges: [
      { icon: '🔥', name: 'רצף ברזל',    value: '9 ימים רצופים' },
      { icon: '⚡', name: 'RX ללא פשרות', value: '14 מטקונים בתקן' },
      { icon: '💎', name: 'שבוע מושלם',  value: '3 שבועות של 5/5' }
    ],
    tests: [
      { name: 'Back Squat — שלשה כבדה', short: 'כוח רגליים', before: '95 ק"ג', after: '110 ק"ג',
        beforePct: 86, afterPct: 100, delta: '+16%', deltaAbs: '+15 ק"ג', betterWhen: 'higher', gain: .16 },
      { name: 'מבחן אירובי — 3 סבבים', short: 'סיבולת אירובית', before: '19:12', after: '16:48', ltrValues: true,
        beforePct: 100, afterPct: 87, delta: 'מהיר ב־13%', deltaAbs: '2:24', betterWhen: 'lower', gain: .13 },
      { name: 'Strict Pull Up — 10 סטים ב־5:00', short: 'משיכה בשליטה', before: '30', after: '40',
        beforePct: 75, afterPct: 100, delta: '+33%', deltaAbs: '+10 חזרות', betterWhen: 'higher', gain: .33 },
      { name: 'C2B/Pull Ups — חזרות לדקה', short: "ג'ימנסטיקה", before: '6', after: '9',
        beforePct: 67, afterPct: 100, delta: '+50%', deltaAbs: '+3 לדקה', betterWhen: 'higher', gain: .50 }
    ],
    testsSummary: '✓ כל 4 המבחנים השתפרו',
    attendance: { weeks: [4,5,3,5,4,2,5,4], done: 32, of: 40, target: 5 },
    keep: [
      { title: 'עקביות',    detail: '3 שבועות מלאים מתוך 8' },
      { title: "ג'ימנסטיקה", detail: 'C2B/Pull Ups עלה ב־3 לדקה' },
      { title: 'משמעת RX',   detail: '14 מטקונים בתקן המלא' }
    ],
    improve: [
      { title: 'סיבולת אירובית', detail: 'שיפור של 2:24 — הקטן מבין 4 המבחנים' },
      { title: 'נוכחות בשישי',   detail: '3 מתוך 8 שבועות' },
      { title: 'השבוע החלש',     detail: 'שבוע 6 — 2 מתוך 5' }
    ],
    prs: [
      { name: 'Back Squat', value: '110 ק"ג' },
      { name: 'Deadlift',   value: '140 ק"ג' },
      { name: 'Clean',      value: '78 ק"ג' }
    ],
    trackedPct: '80% מהבלוק תועד'
  };

  /* ---- C. the quiet card — edge cases 1 + 3 -----------------------------
     What today's data actually produces: W1 baselined, W8 not embedded yet,
     so nothing was re-measured and no LIFT weight was flagged as a PR.      */
  DEMO.edge = {
    logo: 'logo.png',
    athlete: 'אורי עוזל',
    program: 'CAPACITY PROGRAM · 8 WEEKS',
    dateRange: '12/07/2026 – 05/09/2026',
    hero: { eyebrow: 'יומן אימונים', pct: '32', lead: 'תועדו בבלוק', leadShort: 'תועדו',
            label: 'מתוך 40 מתוכננים', before: '', after: '' },
    badges: [
      { icon: '🔥', name: 'רצף ברזל',   value: '9 ימים רצופים' },
      { icon: '💎', name: 'שבוע מושלם', value: '3 שבועות של 5/5' }
    ],
    tests: [
      { name: 'Back Squat — שלשה כבדה', short: 'כוח רגליים', before: '95 ק"ג', after: '',
        beforePct: 100, afterPct: 0, betterWhen: 'higher' },
      { name: 'מבחן אירובי — 3 סבבים', short: 'סיבולת אירובית', before: '19:12', after: '', ltrValues: true,
        beforePct: 100, afterPct: 0, betterWhen: 'lower' },
      { name: 'Strict Pull Up — 10 סטים ב־5:00', short: 'משיכה בשליטה', before: '30', after: '',
        beforePct: 100, afterPct: 0, betterWhen: 'higher' },
      { name: 'C2B/Pull Ups — חזרות לדקה', short: "ג'ימנסטיקה", before: '6', after: '',
        beforePct: 100, afterPct: 0, betterWhen: 'higher' }
    ],
    testsSummary: 'נמדדו שוב · 0 מתוך 4',
    attendance: { weeks: [4,5,3,5,4,2,5,4], done: 32, of: 40, target: 5 },
    keep: [
      { title: 'עקביות',  detail: '3 שבועות מלאים מתוך 8' },
      { title: 'רצף',     detail: '9 ימי אימון רצופים' }
    ],
    improve: [
      { title: 'לסגור מדידה', detail: '4 מבחנים מחכים לרי-טסט' },
      { title: 'נוכחות בשישי', detail: '3 מתוך 8 שבועות' },
      { title: 'השבוע החלש',   detail: 'שבוע 6 — 2 מתוך 5' }
    ],
    prs: [],
    trackedPct: '80% מהבלוק תועד'
  };

  global.BlockRecapDemo = DEMO;
})(typeof window !== 'undefined' ? window : this);
