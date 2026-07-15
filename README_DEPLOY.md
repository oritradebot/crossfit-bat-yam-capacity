# BAT YAM Capacity Tracker — מדריך העלאה לאוויר

האפליקציה שלך מ‑Claude Design, עטופה בשכבת התחברות (מייל+סיסמה) וסנכרון ל‑Supabase.
**קוד האפליקציה עצמה לא שונה** — כל עדכון עתידי שתעשה ב‑Claude Design פשוט מחליף את קובץ ה‑app ומתחבר לאותה שכבה.

מבנה התיקייה:
```
capacity-app/
├─ public/               ← זה מה שעולה לאוויר
│  ├─ index.html         ← מסך התחברות / הרשמה
│  ├─ app.html           ← האפליקציה שלך (הנתונים נטענים לפני האתחול)
│  └─ assets/            ← react, dc-runtime, פונטים, תמונה, boot.js, supa-config.js
├─ supabase/schema.sql   ← להריץ פעם אחת ב‑Supabase
├─ vercel.json
└─ README_DEPLOY.md
```

---

## שלב 1 — Supabase (מסד הנתונים + התחברות)

1. היכנס ל‑https://supabase.com → **New project**. בחר שם, סיסמה, region (בחר Frankfurt — הכי קרוב). חינם.
2. כשהפרויקט מוכן: **Settings → API**. העתק את שני הערכים:
   - **Project URL**
   - **anon public key**
3. פתח את `public/assets/js/supa-config.js` והדבק אותם במקום ה‑placeholders.
4. ב‑Supabase → **SQL Editor → New query** → הדבק את כל התוכן של `supabase/schema.sql` → **Run**.
5. (אימות מייל) בברירת מחדל Supabase שולח מייל אימות בהרשמה. לפיילוט של 50 אנשים אפשר לכבות:
   **Authentication → Providers → Email → כבה "Confirm email"** (מקל על הכניסה הראשונה).

---

## שלב 2 — GitHub (אחסון הקוד)

1. צור ריפו חדש (למשל `capacity-tracker`).
2. העלה את כל התיקייה `capacity-app` אליו (גרירה בממשק GitHub, או git push).

> אם אתה עובד עם ה‑repo הקיים `oritradebot` — פשוט צור ריפו נפרד חדש, לא לערבב עם ה‑trading server.

---

## שלב 3 — Vercel (העלאה לאוויר)

1. היכנס ל‑https://vercel.com עם חשבון ה‑GitHub.
2. **Add New → Project** → בחר את הריפו.
3. Framework Preset: **Other**. Output Directory: `public`. **Deploy**.
4. תוך דקה תקבל כתובת כמו `https://capacity-tracker.vercel.app` — זה הקישור שאתה משתף עם 50 האנשים.

כל `git push` עתידי = deploy אוטומטי.

---

## שלב 4 — הפוך את עצמך ל‑Admin

1. היכנס לאפליקציה (הכתובת מ‑Vercel) → **הרשמה** עם המייל שלך.
2. ב‑Supabase → SQL Editor → הרץ (החלף את המייל):
   ```sql
   update public.profiles set is_admin = true
   where id = (select id from auth.users where email = 'YOUR-EMAIL');
   ```
3. מעכשיו, כשאתה עורך את התוכנית באפליקציה (מצב Admin, קוד `batyam`), היא נשמרת ל‑`shared_program` וכל המשתמשים רואים אותה. לכל משתמש נשמרות התוצאות האישיות שלו בנפרד.

---

## עדכון עיצוב עתידי (מ‑Claude Design)

כשתשדרג ב‑Claude Design ותייצא קובץ HTML חדש — שלח לי אותו, אני מחלץ ומחליף את `public/app.html` (+ assets אם השתנו) בלי לגעת ב‑`index.html`, `boot.js` או ב‑schema. push ל‑GitHub → Vercel מעלה אוטומטית. **נתוני המשתמשים ב‑Supabase לא נמחקים** — הם חיים בנפרד מהקוד.

---

## איך זה עובד מאחורי הקלעים (לידיעה)

- `boot.js` רץ לפני אתחול האפליקציה: מוודא שיש session, מושך מ‑Supabase את התוכנית המשותפת + התוצאות שלך, ממזג אותן, וכותב ל‑`localStorage` — ורק אז טוען את `dc-runtime.js` שמפעיל את האפליקציה.
- כל שינוי שהאפליקציה כותבת ל‑`localStorage` מיורט ונדחף ל‑Supabase (עם השהיה קטנה כדי לא להעמיס).
- הלוח (board) משותף: כל אחד מעדכן רק את השורה שלו, אבל כולם קוראים את כולם.

---

## בדיקה מקומית לפני העלאה (מומלץ)

בתוך התיקייה:
```bash
cd capacity-app/public
npx serve        # או:  python3 -m http.server 8080
```
פתח בדפדפן, ודא שמסך ההתחברות עולה ושאחרי כניסה האפליקציה מתאתחלת.
זה השלב היחיד שאני לא יכול לבדוק בעצמי — לוודא שהאתחול תקין בדפדפן אמיתי.
```
