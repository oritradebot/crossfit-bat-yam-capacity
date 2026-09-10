# 🗺️ מפת הקוד — `app.html` ו-`boot.js`

**אין כאן מספרי שורות — הם מתיישנים תוך יום.** המפה החיה:

```bash
python tools/map.py              # שני הקבצים
python tools/map.py app program  # רק סקשנים ששמם מכיל "program"
sed -n "A,Bp" public/app.html    # ואז קוראים סקשן אחד
```

`map.py` קורא עוגני-הערה. כשמוסיפים אזור חדש — מוסיפים עוגן:
`// ---- שם ----` ב-JS · `<!-- ---- שם ---- -->` בתוך התבנית · `<!-- ==== SECTION: שם ==== -->` לאזור-על.

---

## `public/app.html` (~4,900 שורות, ~430KB) — אזורי-העל

| אזור | מה יש שם | כלל |
|---|---|---|
| **recap card renderer** | `BlockRecapCard` — IIFE שמצייר את כרטיס סיכום הבלוק | מודבק **מילה במילה** מ-`design/block-recap/recap-card.js`. לא עורכים כאן — עורכים שם ומדביקים מחדש |
| **recap data builder** | `BlockRecap.build` — קורא את ה-state ובונה את נתוני הכרטיס; `gateState` | כנ"ל, מ-`recap-build.js` |
| **boot.js load + boot splash** | `<script src=boot.js>` + CSS ו-markup של מסך הטעינה | boot.js רץ **לפני** האפליקציה: אימות, מיזוג, ואז `.cfby-ready` |
| **app template** | `<helmet>` (פונטים + פלטות ערכת נושא) ואז ה-markup עם bindings `{{ }}` ובלוקי `sc-if` | dc-runtime מרנדר. **אין JSX.** תתי-סקשנים `template: …` לכל טאב ומודאל |
| **app logic** | `class Component extends DCLogic` — כל הלוגיקה, מתודות בהזחה של 2 רווחים; `renderVals()` מספק לתבנית את הערכים | תתי-סקשנים `// ----` (למטה) |
| thumbnail template | SVG לתצוגה מקדימה | לא נוגעים |

### app template — תתי-סקשנים
`page shell + header` · `demo strip (isDemo)` · `overview tab (isOverview)` · `records + tests tab (isPRs)` · `log tab (isLog)` · מודאלים: `welcomeOpen` (מדריך ראשון), `onbOpen`, `movesOpen`, `shareOpen` (שיתוף יום + כרטיס בלוק), `builderOpen` (בונה תוכנית, מנהל), `profileOpen`, `liftChartOpen`, `hasCelebrate`, `hasToast`, `adminOpen`.

### app logic — תתי-סקשנים, בסדר הופעה

| סקשן | מה | הערה |
|---|---|---|
| constants + program skeleton | `BLOCK_NUM`, `KEY`, `WEEKLY_TARGET`, `MOVEMENTS`, `emptyDay`, `buildProgram` | |
| demo mode | `DEMO_LOG`, `seedDemo`, `freshProgram` | רק ל-`/demo` |
| PROGRAM_VERSION + IS_DEMO + DEMO_MAPS | `PROGRAM_VERSION` עולה ב-1 בכל הטמעה | `grep -n "PROGRAM_VERSION ="` |
| richer result entry | **מפות ההזנה:** `PER_SET_LIFT`, `PER_MOVE_METCON/BOXES/SCORE/OFF`, `METCON_AMOUNT_LABEL`, `TIME_SPLITS`, `ROUND_REPS` | ממולאות בכל הטמעה — `program.md §3` |
| session helpers · program text · celebration · lift PR check · level pills | עזרי סשן, טקסט התוכנית (`planEl`, שורות `L1 =`), קונפטי, בדיקת שיא, הרמה כשלב 1 | |
| "בפעם הקודמת עשית…" · "הורד את הנתונים שלי" · set fill | ההשוואה מול עצמך, ייצוא CSV, מילוי סטים | |
| **BLOCK 2 program** | `blankWeek`, `programWeek1()..programWeek8()` | **תוכן האימונים.** `/embed-week` כותב כאן |
| BLOCK 1 program (demo only) | `demoWeek1()..demoWeek8()` — 40KB | **לא קוראים אף פעם.** האפליקציה האמיתית לא נוגעת בזה |
| **applyProgram** | ה-overlay של התוכנית על ה-state בכל boot + `normalizeDay/normalizeWeeks` | **רגיש** — חוקי ברזל 5-6. `program.md §4` |
| calendar index helpers | `cwi`, `todayIdx`, `selIsFuture`, `altLockNote` | `startDate` של הבלוק |
| storage keys + React lifecycle | `componentDidMount` ועוד | |
| week stats, badges, local save | `weekStats`, `save` (כתיבה ל-localStorage — משם boot.js דוחף) | |
| edit plumbing · effort scale · input widgets · log bars | `onEditPath`, `EFFORT` (קל/בסדר/קשה), `numEl/timeEl`, `liftBar/metconBar/extraBar` | ה-UI של ההזנה |
| personal records | פנקס השיאים, בלוקים קודמים (`profiles.prs`) | `block-transition.md §7` |
| completion checks · save bar | `canComplete`, `saveDay/unsaveDay` — השלמה קפדנית | `personal-v3.md` |
| date + day-state helpers | `dateAt`, `rangeStr`, `dayState` | |
| **renderVals** | כל מה שהתבנית קוראת; בתוכו: records, profile card, tests screen | הגדול ביותר |
| style helpers, admin code, builder edits · share · block recap card · day share card · program builder | סגנונות, קוד מנהל, שיתוף, כרטיס הבלוק, בונה התוכנית | |

---

## `public/assets/js/boot.js` (~2,800 שורות, ~175KB) — סקשנים

| סקשן | מה |
|---|---|
| (ראש הקובץ) | `BUILD` — גרסה; זהה ל-`version.json` |
| demo mode · theme · helpers | `/demo`, ערכת נושא (auto/light/dark), `lsGet/lsSetRaw` |
| Supabase reads | `fetchSharedProgram`, `fetchMyState`, `fetchMyBoardRow`, `fetchProfile`, `fetchAnnouncement` |
| program scaffold hygiene · **day-level merge (v1.7.0)** | `stripLogs`, `cleanLog`, `logSig`, `stampChangedDays`, **`mergeTrackers`** — המיזוג היחיד, רק ב-boot (חוק 5) |
| Supabase writes · maintenance + block reset · block epoch · sync status badge | `dropLocalCopy`, `maintenanceFlag`, החיווי בפוטר, `reauthTap` |
| self-update | `checkFreshBundle`, `checkCloudFresh`, `versionTag`, `upsertWithRetry`, `rpcWithRetry`, `doPushState` |
| **v3: days-only routine push** | `pushState`, `publicSummary`, `doPushBoard`, `keepalivePush`, `flushPending`, **`installInterceptor`** (Storage.prototype, חוק 4) — נתיב הכתיבה כולו |
| in-app ADMIN panel + coach view + log viewer + progress table + backup/restore + announcements + recap gate + block reset + announcement log VIEW | הפאנל — מוזרק רק למנהלים | 
| first-login mini-onboarding · block announcement popup · no-connection gate | | 
| local dev preview (`?dev=1`) · demo (`?demo=1`) · **main** | `devMain` לא מריץ `main()` — הנתיב האמיתי נבדק רק בפרודקשן |

---

## מה לא קוראים
- `demoWeek1..8` (בלוק 1) · שני סקריפטי הכרטיס המודבקים · `public/assets/js/{react,react-dom,dc-runtime,html2canvas}.js` · `design/block-recap/standalone.html`.
- `.claude/settings.local.json` — 33KB של הרשאות, אין שם מידע.
- `docs/archive/` — רק כשחוקרים היסטוריה.
