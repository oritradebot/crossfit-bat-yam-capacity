# 🚀 תחום: שחרור גרסה — BUILD, version.json, פריסה ואימות

> נכתב 10/09/2026 מתוך הזיכרון על העדפות הגרסאות של אורי + הזרימה שעבדה בפועל מאז 07/2026.

## 1. הכרעות אורי — הוא בוחר את המספר

- **אורי נוקב במספר הגרסה. תמיד.** מציעים מספר, לא מחליטים. מספרי הגרסה הם כלי תקשורת שלו מול המתאמנים, לא semver קפדני.
- תקדימים: דארק מוד (פיצ׳ר מלא, תוכנן כ-1.7.0) יצא כ-**1.6.12** לבקשתו; מ-v1.5.1 עדכוני תוכן תוכנית מעלים את הספרה השלישית; שבועות 4+5 הוטמעו (PROGRAM_VERSION 15→28) כשהאפליקציה קפואה על 1.7.5, ורק בסוף אורי שחרר 1.8.0.
- **"תכין את הכל בלי דחיפה כרגע" = השהיה, לא דחייה.** העבודה נצברת בעץ העבודה עד שהוא נוקב במספר ("תדחוף עם גרסא 2.2.0"), ואז **כל מה שממתין יוצא תחת המספר האחד הזה** (2.2.0 נשא גם הטמעת שבוע 8 וגם שינוי UI מסשן מקביל). לפני העלאת BUILD: `git status` — מה עוד לא מקומט? הודעת השחרור חייבת לכסות הכל.
- דחיפה בלי העלאת גרסה קורית ("תדחוף בלי שינוי גרסא כרגע") — תיקונים קטנים נדחפים תחת הגרסה הקיימת; ראה רשומות 08/09 (1c1597e, 5924da5 תחת 3.0.1).

## 2. המנגנון

| מה | איפה | כלל |
|---|---|---|
| `BUILD` | `public/assets/js/boot.js` (`grep -n "var BUILD" public/assets/js/boot.js`) | חייב להיות **זהה** ל-`version.json` |
| `build` | `public/version.json` | אותו מחרוזת בדיוק |
| `PROGRAM_VERSION` | `app.html` (`python tools/map.py app PROGRAM`) | נפרד לגמרי — עולה ב-1 בכל הטמעת שבוע, לא נוגע ב-BUILD |

- בדיקת העדכון-העצמי היא **שוויון** (`j.build === BUILD`): כל מחרוזת ייחודית עובדת, סדר לא משנה. לכן שינוי מספר בדיעבד הוא רק חיפוש-והחלפה בשני מקומות.
- דף פתוח אצל מתאמן מתרענן לבד כשה-`build` בשרת שונה מזה שרץ אצלו — לכן העלאת BUILD היא הדרך להביא את כולם לקוד החדש (3.0.2 נדחפה בדיוק בשביל זה).

## 3. הזרימה שעובדת

0. **`python tools/release_check.py`** — חייב להיות ירוק (10/09): BUILD == version.json, BLOCK == BLOCK_NUM, אין CRLF בקבצים המנוהלים, PROGRAM_VERSION עלה אם טקסט התוכנית השתנה מול HEAD, שני בלוקי כרטיס הסיכום זהים ל-`design/block-recap/`, חוקי ברזל 1 ו-4 ב-boot.js, אין סקריפטים מ-CDN. נכשל → מתקנים לפני ה-commit. נגעת בסקשן המיזוג של boot.js? גם `tools/merge-tests.html` בדפדפן (sync.md §5) חייב 14/14.
1. commit רק כשאורי מבקש. לפני commit: נרמול CRLF→LF לקבצים שנערכו (`python -c ...` מ-CLAUDE.md), ו-`git diff --stat` לוודא שרק מה שהתכוונו נכנס.
2. `gh` **לא מותקן** — אין PR מה-CLI. Vercel פורס מ-`main` בלבד. הזרימה: ענף → commit → push לענף → מיזוג fast-forward ל-`main` → push (או ישירות ל-`main` בתיקונים קטנים, כמו ב-08/09).
3. **אימות מול הפרודקשן אחרי כל פריסה** — ואז commit נפרד ליומן ("journal: … production verified"):
   ```bash
   curl -s https://crossfit-bat-yam-capacity.vercel.app/version.json
   curl -s https://crossfit-bat-yam-capacity.vercel.app/assets/js/boot.js | grep -m1 "var BUILD"
   curl -s -o /dev/null -w "%{http_code}" https://crossfit-bat-yam-capacity.vercel.app/app
   ```
   `/app.html` מחזיר 308 תחת `cleanUrls` — בודקים `/app`.
4. בטלפון של אורי: תווית הגרסה בפוטר (`#cfbyVer`) חייבת להראות את המספר החדש. אם לא — Service Worker מגיש צילום ישן (ראה מלכודות ב-CLAUDE.md).

## 4. ❌ מה נדחה ולמה

- **מספר גרסה זמני "עד שאורי יחזור"** (1.9.1 בזמנו) — לא עושים. נשאר יתום. ממתינים למספר שלו.
- **semver אוטומטי** (פיצ׳ר = minor) — נדחה במפורש בתקדים 1.6.12.

## 5. מלכודות

- `git merge` (לא רק Edit ו-checkout) מחזיר CRLF לקבצים — אחרי מיזוג, לבדוק ולנרמל לפני השוואות ולפני commit.
- הדגל `maintenance` ב-`version.json` (v2.3.0) חי באותו קובץ — לא לדרוס אותו כשמעלים גרסה. ראה `block-transition.md §2`.

## 6. ספריית Supabase מקומית (10/09/2026)

- `public/assets/js/supabase.js` = עותק מוצמד של `@supabase/supabase-js` **2.116.0** (UMD). שלושת הדפים (`index.html`, `app.html`, `confirmed.html`) טוענים אותו במקום `cdn.jsdelivr.net/.../supabase-js@2`, שהיה "הגרסה האחרונה של 2.x" בכל טעינה.
- למה: שדרוג מכוון במקום אוטומטי (גרסה שוברת ב-CDN לא נוחתת אצל כולם בלי דיפלוי שלנו), ואותו מקור — ה-SW שומר קבצי אותו מקור, ולכן הספרייה זמינה גם בפתיחה בלי קליטה.
- שדרוג: להוריד `https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.X.Y/dist/umd/supabase.js` מעל הקובץ, לעדכן את מספר הגרסה בהערה שבראשו, ולאמת דף התחברות + אפליקציה בפרודקשן (§3). לא נוגעים ב-`supa-config.js`.
- כותרות אבטחה ב-`vercel.json` (מאותו דיפלוי): `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`, `Permissions-Policy` (מצלמה/מיקרופון/מיקום/תשלום כבויים), ו-CSP חלקי (`frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'self'`). אימות אחרי פריסה: `curl -sI https://crossfit-bat-yam-capacity.vercel.app/app | grep -iE "frame|csp|content-security|referrer|permissions"`. CSP מלא על סקריפטים לא אפשרי — `app.html` בנוי מסקריפטים בתוך הדף.
