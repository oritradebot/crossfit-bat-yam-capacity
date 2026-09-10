# CrossFit Bat Yam — Capacity Tracker

אפליקציית מעקב אימונים ל-CrossFit Bat Yam. אפליקציה שיוצאה מ-Claude Design
(`public/app.html`) עטופה בשכבת התחברות וסנכרון מול Supabase (`public/assets/js/boot.js`).
פרוסה ב-Vercel מ-`main` בלבד → https://crossfit-bat-yam-capacity.vercel.app

**בעלים והמחליט היחיד: אורי.** הוא בוחר מספרי גרסה, מאשר תוכן תוכנית, ומחליט מה מקומט ומה נדחף.
מתאמנים נכנסים בשם משתמש; במסד זה מייל סינתטי `username@batyam.app` — מייל אמיתי לא נשלח אף פעם.

---

## 🚨 חוקי ברזל — אסור להפר

כל אחד מהם קיים כי ההפרה שלו גרמה לאובדן נתונים אמיתי אצל מתאמנים.

1. **אסור להוסיף `.select()` ל-upsert של `states`** — מהדהד 70KB בכל שמירה.
2. **אסור לחסום כתיבה** בגלל רשת/סשן. אין כתיבה → אין חותמת `cfby_dirty_v1` → הבוט הבא מוחק הכל.
3. **אסור להפנות אוטומטית ל-login** בכשל אימות. `location.replace()` הורג את `memTracker`.
4. **אסור להשמה על המופע**: `localStorage.setItem = fn`. עוטפים `Storage.prototype.setItem`. (Safari 26 עוקף.)
5. **אסור לתת לשרת לנצח באמצע סשן.** מיזוג קורה רק ב-boot, ב-`mergeTrackers`.
6. **אסור להוסיף תוכן תוכנית שאורי לא שלח.** ציטוט: *"אם אין בתוכנית ששלחתי לך אל תוסיף"*.
7. **אסור לשנות `resultMode` בשבוע סגור** — שובר את ההשוואה מול עצמך (מבחנים, "בפעם הקודמת").

עצה סטנדרטית של Supabase/React היא **רגרסיה** כאן. התקרית מאחורי כל חוק: [`docs/domains/sync.md`](docs/domains/sync.md).

---

## 💰 חסכון בטוקנים — איך קוראים את הריפו הזה

הקבצים הגדולים **לא נקראים במלואם, אף פעם**: `app.html` (430KB), `boot.js` (175KB), היומן (95KB), הארכיון (250KB).

| צריך | עושים | לא עושים |
|---|---|---|
| להתמצא ב-`app.html` / `boot.js` | `python tools/map.py app` (או `boot`, או `app program`) → `sed -n "A,Bp"` על הסקשן בלבד | Read/cat על הקובץ, "לקרוא קצת מהאמצע" |
| למצוא סימבול | `grep -n "name" public/app.html` → ‏±30 שורות סביב | לקרוא סקשן שלם בשביל שורה אחת |
| מה קרה לאחרונה | `python tools/journal_tail.py` — רשומה אחרונה + הרשימה הפתוחה (`3` = שלוש אחרונות, `--headings` = רק כותרות) | `cat יומן-פרויקט.md` |
| ידע תחום | **מסמך התחום הרלוונטי בלבד** (טבלה למטה) | כל `docs/` |
| היסטוריה | `docs/archive/` — רק כשחוקרים משהו ישן | |
| חיפוש רחב (הרבה קבצים / כיוונים) | סוכן Explore שמחזיר **מסקנה** | grep-ים חוזרים בקונטקסט הראשי |

- **פלט כלים:** לפני שמדפיסים משהו > ~3KB — `head`, `cut -c1-120`, `grep`. אין להדפיס `settings.local.json` (33KB הרשאות, אפס מידע).
- **לא קוראים אף פעם:** `demoWeek1..8` (תוכנית בלוק 1, לדמו בלבד, 40KB) · שני סקריפטי כרטיס הסיכום בראש `app.html` (מודבקים מילה במילה מ-`design/block-recap/` — עורכים **שם**) · `public/assets/js/*` חוץ מ-boot.js · `design/block-recap/standalone.html`.
- **עריכה בקבצים גדולים:** סקריפט Python קצר (חיפוש-והחלפה עם `assert count == 1`, כתיבה עם `newline="
"`) — לא Read של הקובץ כדי לערוך.
- **עוגנים:** אזור חדש ב-`app.html`/`boot.js` מקבל באנר `// ---- שם ----` (בתבנית: `<!-- ---- שם ---- -->`; אזור-על: `<!-- ==== SECTION: שם ==== -->`). `map.py` קורא אותם. **אין מספרי שורות במסמכים** — מתיישנים תוך יום.
- **סוכני-רקע** לניסוח מסמכים ולבדיקות-כיסוי; הקונטקסט הראשי מקבל רק את הדוח.

---

## 🗺️ איפה כל דבר

| מה | איפה | הערה |
|---|---|---|
| האפליקציה | `public/app.html` | ~4,900 שורות. [`docs/MAP.md`](docs/MAP.md) + `python tools/map.py app` |
| שכבת הסנכרון | `public/assets/js/boot.js` | `BUILD` בראש הקובץ (`grep -n "var BUILD"`) |
| תוכן האימונים | `app.html` → `programWeek1()..programWeek8()` | סקשן **BLOCK 2 program** (`map.py app program`) |
| מפות ההזנה | `PER_SET_LIFT`, `PER_MOVE_*`, `METCON_AMOUNT_LABEL`, `TIME_SPLITS`, `ROUND_REPS` | סקשן **richer result entry** |
| גרסה | `public/version.json` + `BUILD` | **חייבים להיות זהים.** [`release.md`](docs/domains/release.md) |
| סכימת DB | `supabase/schema.sql` | מתעדכן ידנית — ה-DB החי מקבל ALTER בנפרד |
| יומן | `יומן-פרויקט.md` | בלוק 2 והלאה. בלוק 1: `docs/archive/journal-block-1.md` |
| כלים | `tools/` | `map.py`, `journal_tail.py`, **`release_check.py` (לפני כל commit)**, `merge-tests.html` (בדפדפן, לפני נגיעה במיזוג); `block_summary.py` + `recap_cards_server.py` רצים על קובץ גיבוי |
| דמו למשתתפים | `/demo` → `app.html?demo=1` | `demoMain` ב-boot.js + `DEMO_LOG` ב-app.html — [`personal-v3.md` §ד](docs/domains/personal-v3.md) |

---

## 📚 מסמכי תחום — קרא רק את הרלוונטי

| תחום | קובץ | מתי |
|---|---|---|
| 🏋️ הטמעת תוכנית | [`program.md`](docs/domains/program.md) | הטמעת שבוע, `resultMode`, מפות ההזנה, מלכודות סנכרון בשדות לוג |
| 🎯 v3 אישי | [`personal-v3.md`](docs/domains/personal-v3.md) | היומן / הסקירה / המבחנים / הפאנל של v3, הכרעות אורי, הדמו. הספק המקורי: `docs/archive/personal-v3-spec-2026-09-07.md` |
| ☁️ סנכרון | [`sync.md`](docs/domains/sync.md) | Supabase, boot.js, מיזוגים, היסטוריית תקריות, אבחון |
| 🚀 שחרור | [`release.md`](docs/domains/release.md) | BUILD, version.json, פריסה, אימות מול הפרודקשן |
| 🔄 מעבר בלוק | [`block-transition.md`](docs/domains/block-transition.md) | מצב תחזוקה, איפוס + ארכיון, שיאים בין בלוקים, עובדות בלוק 2 |
| 💾 גיבוי וייצוא | [`backup.md`](docs/domains/backup.md) | גיבוי מהפאנל, סיכומים, כרטיסי PNG מגיבוי |
| 🧭 מפת שיפורים | [`roadmap.md`](docs/roadmap.md) | **הכרעות אורי מ-10/09/2026** — סדר הדיפלויים (§9.2), מה לא נבנה (§9.5). לבדוק לפני כל שיפור חדש |
| 🏁 כרטיס סיכום בלוק | [`design/block-recap/README.md`](design/block-recap/README.md) | חוק ההדבקה, השער, גדלים |
| ♿ נגישות | [`a11y.md`](docs/domains/a11y.md) | מה נעשה 10/09 (שמות לכפתורי אייקון, הפחתת תנועה, פוקוס), מה נדחה (`dir` על השורש, px→rem), איך בודקים |
| 🎨 UI/UX | — | עדיין לא קיים; נכתב בפעם הראשונה שעובדים בתחום |
| 🏆 ניקוד | — | **הוסר ב-v3** (אחוזונים / 70-30 / קטגוריות) |

## ⚙️ נהלים חוזרים

- `/embed-week` — הטמעת שבוע אימונים. **תמיד להשתמש בזה, לא לאלתר.**

---

## ⚠️ מלכודות סביבה

- **CRLF:** Edit, ‏`git checkout` **וגם `git merge`** כותבים CRLF לקבצי LF. אחרי כל עריכה:
  `python -c "p='FILE';b=open(p,'rb').read();open(p,'wb').write(b.replace(b'
',b'
'))"`.
  בהשוואות (חוק ההדבקה של הכרטיס) מנרמלים **את שני הצדדים**.
- **Service Worker:** שרת dev מת + SW מגישים snapshot ישן **בשקט** — גם `fetch(..., {cache:'reload'})`.
  לפני שסומכים על בדיקה מקומית: תווית הגרסה בפוטר (`#cfbyVer`) מול `BUILD`. שחרור: `navigator.serviceWorker.getRegistrations()` → unregister הכל, `caches.keys()` → delete הכל, reload.
  שרת משלך מ-`.claude/launch.json` (`capacity-static` … `-6`); `preview_start` מסרב לפורט של צ׳אט אחר.
- **מצב dev (`?dev=1`) לא מריץ את `main()`** של boot.js — הנתיב האמיתי נבדק רק בפרודקשן. אחרי מחיקת משתנה ב-boot.js: grep על **כל** הקובץ (התיקון החם `fb` ab45b01).
- **כלים במחשב הזה:** `gh` לא מותקן (אין PR מה-CLI). `node` לא מותקן (אין `node --check`). Python 3.14 כן.
- **Bash tool:** ‏`$TMPDIR` ריק — כותבים סקריפטים לנתיב ה-scratchpad המפורש. heredoc עם גרש בודד לא מאוזן שובר את הכלי. Python שמדפיס עברית צריך `sys.stdout.reconfigure(encoding="utf-8")` (המסוף cp1255).

---

## 🔚 בסוף כל סשן

1. **יומן** (`יומן-פרויקט.md`): רשומה אחת, **עד ~10 שורות**, בעברית פשוטה, מה נעשה + למה, בלי קוד. פרטים טכניים → מסמך התחום.
   עדכן את "פתוח / הבא בתור": פריט שנסגר **נמחק** (הרשומה מתעדת), לא נשאר מחוק.
2. **מסמך התחום** הרלוונטי: מה אנחנו יודעים עכשיו — **במיוחד "מה נדחה ולמה"**.
3. **בסוף בלוק:** רשומות הבלוק עוברות ל-`docs/archive/journal-block-N.md` (כמו בלוק 1, 10/09/2026).
4. commit / push — רק כשאורי מבקש, ורק אחרי ש-`python tools/release_check.py` ירוק.

**ההבדל:** היומן = *מה קרה* (כרונולוגי, לאורי). מסמך התחום = *מה אנחנו יודעים עכשיו* (עדכני, לקלוד).
