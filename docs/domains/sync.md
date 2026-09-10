# ☁️ תחום: סנכרון — Supabase, boot.js, מיזוגים

**מה זה:** `public/assets/js/boot.js` — מביא מ-Supabase, ממזג עם העותק במכשיר, מיירט כל כתיבה ל-`localStorage` ודוחף לענן. עודכן 10/09/2026 (BUILD 3.0.2).
**חוקי הברזל: ראה `CLAUDE.md` — כאן ההסבר והתקרית מאחורי כל אחד.**

---

## 1. איך זה בנוי היום

- **Boot** (`boot.js › main / main`): סשן → `fetchProfile` + `maintenanceFlag` → זריקת עותק מבלוק קודם → `fetchMyState` → `mergeTrackers` → `installInterceptor` + probe → `dc-runtime.js`. `applyProgram` (app.html) רץ **בכל** boot ללא תנאי (2.0.0). כשל fetch ≠ "אין שורה": עם עותק מקומי — boot ממנו בלי לגעת; בלעדיו — `waitForServer`.
- **מיזוג** (`boot.js › day-level merge / mergeTrackers, logSig, stampChangedDays`): חותמת לכל יום (`cfby_dts_v1`) נוסעת בבלוב כ-`tracker._dts`. האחרון שנגע מנצח; בשוויון רישום מנצח ריק (2.2.3), ואז `cfby_dirty_v1` מול `updated_at`. `logSig` = שדות רישום בלבד. **רק ב-boot.**
- **כתיבה** (`installInterceptor`): עוטף `Storage.prototype.setItem`. כתיבת טראקר → מראות בזיכרון (`memTracker`, `memDirtyDays`…) **לפני** המכשיר → `cfby_dirty_v1` → `pushState` (800ms) + `pushBoard`. כתיבה שנכשלה → `localfail`, ועדיין דוחפים.
- **דחיפה** (`boot.js › Supabase writes / doPushState`): שגרתי (v3) = RPC `push_days` עם הימים שנכתבו בלבד (~2KB); בלוב מלא = `upsert` ל-`states` **בלי `.select()`** — אין ימים ממתינים, מנהל (מפרסם `shared_program` דרך `stripLogs`), >20 ימים, RPC חסר/`norow`.
- **סגירה** (`keepalivePush`, `flushPending`): ב-`pagehide`/`hidden` — flush + `fetch keepalive`: RPC תחילה; בלוב מלא רק <60KB (הבלוב ~71KB → מדלג). הסיבה ב-`cfby_ka_fail_v1` ל-boot הבא. **הסמנים לא נמחקים.** retry גם ב-`online`/`visible`/כל 15s עם dirty.
- **רענון בין מכשירים** (`boot.js › self-update / checkCloudFresh`): בדף **נקי** — select `updated_at` בלבד; שרת חדש ב->1.5s → reload. **גרסה** (`checkFreshBundle`): `version.json` no-store, reload אחד לכל build, לא מעל dirty; `sw.js` חדש מנווט בכוח דף שלא עונה תוך 3.5s.
- **"השורה נעלמה"** (`cfby_srvrow_v1`) + **תקופת בלוק** (`boot.js › block epoch / BLOCK, dropLocalCopy`): אין שורה + סימן = איפוס → זרוק; אין שורה + אין סימן + dirty = משתמש חדש → שמור ודחוף. עותק עם `cfby_block_v1` < `BLOCK` נזרק **לפני** המיזוג. פירוט: [`block-transition.md`](block-transition.md) §4.

## 2. חוקי הברזל — התקרית מאחורי כל אחד

| חוק | מה נשבר, מתי | בקוד |
|---|---|---|
| 1. בלי `.select()` | מהדהד 70KB בכל שמירה; `.single()` = PGRST116 + לולאת retry (27/07) | `upsertWithRetry` |
| 2. לא לחסום כתיבה | אין כתיבה → אין dirty → boot "משתמש חדש" מוחק הכל (24/07) | `installInterceptor` |
| 3. בלי redirect ל-login | `location.replace()` הורג `memTracker` — העותק היחיד כשאחסון iOS מת (27/07); רשת מתה ≠ סשן מת | `pushFailed`, `reauthTap` |
| 4. `Storage.prototype`, לא המופע | Safari 26.6, 04/09: `setItem = fn` נשמר כפריט; האייפון לא דחף יממה ונמחק במיזוג | `installInterceptor` + probe |
| 5. השרת לא מנצח באמצע סשן | סשן מת = 200 עם 0 שורות **בלי שגיאה** — "לסמוך על השרת" מוחק | `mergeTrackers`, `checkCloudFresh` |
| + בלי `storage:` ב-`createClient` | iOS "חסום עוגיות" → SecurityError = מסך ריק (מהזיכרון — לא אומת בקוד) | `createClient(url,key)` |

חוקים 6-7 שייכים ל-[`program.md`](program.md).

## 3. היסטוריית תקריות

| גרסה | תאריך | תסמין | שורש | תיקון |
|---|---|---|---|---|
| 8fab307 | 24/07 | "האימון נעלם" | debounce מת עם ה-PWA; boot דרס בעותק שרת ישן | `cfby_dirty_v1`, flush ב-hidden/pagehide/online |
| b40ad5a, 1.0.1 | 25/07 | "רק האימון הראשון שורד" | כשל fetch נקרא "אין שורה" → מחיקה + דחיפת שלד; `shared_program` פורסם עם רישומי אורי | הפרדת שגיאה, `waitForServer`, `stripLogs`; `version.json`+`BUILD` |
| 1.6.15 | 26/07 | טלפונים תקועים על קוד ישן | בנדלים לפני 1.0.0 לא בודקים version.json | `sw.js` `cfby-cache-v2`: פינג + navigate בכוח |
| 1.7.0 | 27/07 | משתמשת חדשה איבדה סשנים | keepalive מת לכולם (>64KB); "אין שורה" מחק ללא תנאי; last-writer-wins על כל הבלוב | מיזוג יום-יום; no-row+dirty → שמור ודחוף |
| 1.7.1 | 27/07 | "נשמר ואז נעלם" | אחסון iOS מת בשקט; דחיפות קראו מהאחסון; SW ניווט בכוח | מראות בזיכרון; דחיפה סריאלית; `normalizeDay` מעתיק `rest` |
| 1.7.2-1.7.3 | 28-30/07 | "שמירה מהאייפון לא עובדת" | keepalive נכשל בשקט; רישום → סגירה מיידית + אחסון מת = אבד | `cfby_ka_fail_v1`; RPC `push_days`, `memDirtyDays` |
| 1.7.4 | 01/08 | "אין גלולה"; מכשירים לא מתעדכנים | dc-runtime בונה `<body>` מחדש; פיוס רק ב-boot | גלולה + observer, `#cfbyCloud`, `checkCloudFresh` |
| 2.0.0 | 28/08 | "W7 מציג רק ראשון" | טקסט תוכנית בלי חותמת → שלד ריק ניצח; `applyProgram` נעול על `pv` | `applyProgram` בכל boot |
| 2.2.3 | 04/09 | "שומר מהמחשב, מתאפס בטלפון" | Safari 26 named-setter | `Storage.prototype`, probe, "רישום מנצח ריק" |

## 4. מסד הנתונים

**טבלאות** (`supabase/schema.sql`): `profiles`, `states` (`tracker` jsonb ~70KB + `updated_at`), `board` (סיכום אישי; מ-v3 רק הבעלים והמנהל קוראים), `shared_program` (id=1; `weeks` נמשך רק למשתמש חדש), `block_archive`.
**RPC:** `push_days` — SECURITY INVOKER, RLS חל, **לא יוצר שורה**. `is_admin()` DEFINER — חובה בפוליסות מנהל על `profiles` (inline = רקורסיה 42P17; 16/07 חסם יצירת פרופילים). `admin_delete_user` (מוחק `auth.users`), `admin_reset_block` (ארכיון+מחיקה+איפוס בטרנזקציה).
**RLS:** owner לפי `auth.uid()`, מנהל דרך `is_admin()`; anon בלי הרשאות (42501).
**pg-safeupdate:** ה-API מסרב ל-`delete`/`update` בלי WHERE **גם בתוך פונקציה** (07/09). טבלה שלמה = `where true`. לבדוק RPC דרך ה-API, לא רק ב-SQL editor.
**סחף סכימה:** אורי מריץ ALTER ידנית; `schema.sql` מתעדכן אחרי, idempotent. הקוד סובל עמודות חסרות.
**anon probe:** RPC `POST /rest/v1/rpc/<fn>` → 401/42501 קיים, 404 חסר. עמודה `GET /rest/v1/<t>?select=<col>&limit=1` → 42501 קיימת, 42703 חסרה.

## 5. איך מאבחנים

- **📜 יומן פעולות מנהל (10/09, דיפלוי 7):** טבלת `admin_audit` — שלוש פונקציות המנהל כותבות שורה בעצמן (מחיקת משתמש, איפוס סיסמה, איפוס בלוק עם המספרים), והפאנל רושם שחזור מגיבוי, פתיחה/סגירה של כרטיס הסיכום ויצירת משתמש. בלי FK לחשבון, כדי שהשובל ישרוד מחיקה. 30 האחרונים מוצגים בתחתית מסך 🩺.
- **🩺 בריאות המכשירים בפאנל (10/09, דיפלוי 6):** boot.js כותב לטבלה `client_errors` (שורה של המתאמן עצמו בלבד, RLS) שגיאות לא-תפוסות, הבטחות שנדחו, כשלי דחיפה כשיש רשת, אחסון מקומי מת ו-interceptor שלא נתפס — עד 20 לסשן, בלי כפילויות, בלי לחכות ובלי לזרוק. הפאנל מציג את 50 האחרונים עם שם/גרסה/סוג, מונה 7 ימים, כפתור ניקוי, ורשימת מכשירים על גרסה ישנה (מ-`pub.build`, דיפלוי 5). בלי הטבלה (ה-SQL לא רץ) ההכנסה נכשלת בשקט והמסך אומר להריץ את `supabase/2026-09-10-client-errors.sql`.

- **אובדן:** תג גרסה בפוטר מול `BUILD`; הופיע "✓ נשמר בענן"?; היום עבר ל-✅?; `cfby_dts_v1` מול `tracker._dts`; קונסול `[sync]`.
- **הקלדה או heartbeat:** מרווח חציוני 3-4s בין POST /states = debounce לכל כתיבה; קצב קבוע 15s = heartbeat (רק עם dirty).
- **אייפון שלא דוחף:** GET-ים של boot + POST board אחד, בלי POST /states או push_days (04/09); פוטר בלי שעה.
- **מחיקת נתוני משתמש:** למחוק `states`+`board` כשהאפליקציה **סגורה ומסונכרנת**; בפתיחה הבאה `cfby_srvrow_v1` + אין שורה → העותק נזרק. חשבון = `admin_delete_user` מהפאנל.
- **"כולם על קוד ישן":** לשנות בייט ב-`sw.js` ולפרוס.

## 6. ❌ מה נדחה ולמה

| הרעיון | למה | מתי |
|---|---|---|
| לכווץ את הבלוב מתחת ל-64KB | המיזוג ב-boot מכסה; התיקון האמיתי = RPC ימים (1.7.3) | 27/07 |
| 5 תיקוני "כשל שקט" סטנדרטיים | רגרסיות — הפכו לחוקים 1-3, 5 + `storage:`; יושמו רק de-silence ל-keepalive ובדיקת `r.error` (מהזיכרון) | 27-28/07 |
| ניקוי dirty בהצלחת RPC בסגירה | הדף מת, `.then` לא מובטח; re-apply אידמפוטנטי | 30/07 |
| reload אחרי 12h | הוחלף ב-`checkFreshBundle` | 26/07 |
| `signOut` גלובלי | מבטל refresh token בכל המכשירים → `scope:"local"` | — |

## 7. מלכודות

1. **dc-runtime בונה `<body>` מחדש בכל render** — כל אלמנט ש-boot.js מזריק חייב להיות מוחזר ע"י ה-observer של `versionTag` (בהחזקה), אחרת נעלם בשקט.
2. **dev (`?dev=1`) לא מריץ `main()`** — 07/09: `fb` נשאר אחרי הסרת fetch הלוח → ReferenceError בכל התחברות (ab45b01). אחרי מחיקת משתנה: grep על כל הקובץ.
3. **Safari 26** — חוק 4; הסימן: `nointercept`. לא נוגעים ב-`installInterceptor` בלי ה-probe.
4. **סשן מת ≠ שגיאה** — לכן `rowGone` דורש פרופיל מאושר ו-`checkCloudFresh` מתעלם מ"אין שורה".
5. **iOS: Safari ו-PWA = שני אחסונים** = שני "מכשירים". `BLOCK`=`BLOCK_NUM`, `BUILD`=`version.json` — זוגות בקבצים שונים.
6. **dirty תקוע** באחסון שמסרב ל-`removeItem` — `dirtyStuck` מנטרל.

## 8. אבחון מהדשבורד של Supabase

פרויקט `rijkgwlbhyfocqykrnod`, דרך claude-in-chrome בכרום של אורי (מחובר, GitHub SSO). probe anon (§4) מוכיח קיום, לא נתונים.

- **Log Explorer** (`/dashboard/project/<ref>/logs/explorer`): טווח + שאילתה ב-URL `?its=<ISO>&ite=<ISO>&s=<SQL מקודד>`, ואז Run (קליק בזמן טעינת ה-SPA נבלע — לחכות ~10s). free tier שומר ~יום. ClickHouse על `logs`, `source = 'edge_logs'`; `log_attributes[...]`: `request.method`, `request.path`, `response.status_code` (מחרוזת — `toUInt16OrZero`), `request.headers.user_agent`, `request.sb.auth_user` (uuid — לחבר ל-`profiles` ידנית), `request.headers.content_length` (upsert מלא ~117KB). `lagInFrame` (partition by מכשיר) → מרווח חציוני בין POST /states = כלל §5. זמנים UTC (ישראל +3 בקיץ). לסנן אותי: `user_agent not like 'curl%'`, `@supabase-infra/mgmt-api`. הגריד וירטואלי — לצבור, לא לרשום.
- **SQL Editor** (`/sql/new`, postgres → `auth.users` קריא): `type` ארוך (~900 תווים) הקפיא; קצר — Escape ואז כפתור Run (ctrl+Enter נבלע). ארוך — `monaco.editor.getModels()[0].setValue(sql)` מ-javascript_tool; המודל שמתחיל בשאילתה הקודמת שלי, לא ריק/אחר — autosave ידרוס את "dashboard v2" של אורי. תוצאות ב-get_page_text.
- **SPA לא נטען → Management API:** מהקשר של supabase.com, `POST https://api.supabase.com/v1/projects/{ref}/database/query`, גוף `{"query":"…"}`, `Authorization: Bearer <access_token>` מ-`localStorage['supabase.dashboard.auth.token']`; pg-meta = 500. ב-11/08 המסווג חסם.
- **טאב ברקע (07/09):** הטאבים שלי לא פעילים → `document.hidden`, הדשבורד לא נטען; כרום זורק טאבים (`Runtime.evaluate` תלוי 45s → `tabs_context_mcp`). דפים קלים כן מריצים JS: קריאה מה-DB = supabase-js + `supa-config.js` ב-`maintenance.html` (הסשן של אורי). SendKeys/DELETE חסומים — DDL: אורי מריץ, או לוחץ על הטאב שיתרנדר.
- **חשבון, בלי הלקוח:** `auth.users.last_sign_in_at` (סיסמה) מול `updated_at` (רענון token ≈ חי) מפריד "לא פותח" מ"פותח ונכשל"; אין שורת `states` = אף סנכרון לא הצליח; `tracker->>'pv'` = הבנדל האחרון במכשיר; `tracker->'_dts'` (`w_d` → ms) = אילו ימים ומתי. בלוב: `weeks[w].days[d]` (0-based), `lift.log.s1..s8`, `metcon.log.*`.
- **תלונה בלי תעבורה (11/08):** סריקת 24h לפי מכשיר — אפס בקשות ואפס 4xx/5xx מהמתלונן = לא מגיע לאפליקציה (PWA על URL פריסה מת, קיר סיסמה), לא סנכרון; "אי אפשר לרשום" = לרוב שבוע שלא הוטמע (COMING SOON).
