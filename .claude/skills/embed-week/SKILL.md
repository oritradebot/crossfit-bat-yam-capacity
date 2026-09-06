---
name: embed-week
description: Embed a week of CrossFit workouts into the Capacity Tracker from Ori's screenshots. Use whenever the task is adding, updating or fixing a program week (הטמעת שבוע, "תטמיע שבוע N", new week's workouts, fixing a day's workout). Reads the screenshots, confirms the day mapping with Ori, writes programWeekN() and the config maps, bumps PROGRAM_VERSION.
---

# הטמעת שבוע אימונים

הידע המלא: [`docs/domains/program.md`](../../../docs/domains/program.md). כאן — השלבים.

## שלב 1 · קריאת המקור

```
C:\Users\leaan\Desktop\crossfit manager project\אימונים להטמעה\week N\
```

קובץ `.jpeg` אחד ליום, שמות בעברית:
`יום ראשון רגיל`, `יום ראשון אינדורנס`, `יום שני` … `יום שבת`

- **שים לב לרווחים נגררים בשמות הקבצים** — הם קיימים שם בפועל.
- אם אורי הדביק תמונות בצ׳אט — הן מגיעות **בלי שמות קבצים**. הצלב מול התיקייה.
- `יום ראשון אינדורנס` → הופך ל-`alt` של יום 0.

## 🛑 שלב 2 · שער אישור — אסור לדלג

הצג לאורי את מיפוי הימים **לפני שכותבים שורת קוד אחת**:

```
יום 0 (ראשון)  · <תוכן שנקרא>   + alt: <אינדורנס>
יום 1 (שני)    · <תוכן שנקרא>
...
```

**אורי בודק את זה במפורש.** הוא רוצה לדעת ששמות הימים באמת נקראו ולא נוחשו.
המתן לאישור.

## שלב 3 · כתיבת התוכנית

ב-`public/app.html`:

1. `programWeekN()` — מבנה מלא לפי `program.md §1`
2. `overlay(N-1, this.programWeekN())` ב-`applyProgram()` (~שורה 2424)
3. **`resultMode` לכל מטקון** — טבלת ההחלטה ב-`program.md §2`. במקרה גבולי — שאל.
4. **ימים ריקים במפורש:** אין lift ביום? `lift: { movement:'', planned:'' }`.
   פחות extras מהשבוע הקודם? הוסף `['','']`. (אחרת נשאר תוכן ישן אצל המשתמשים.)

## שלב 4 · מפות הקונפיג

- `PER_SET_LIFT` — רשומה לכל יום עם מוט. ספירה לפי `program.md §3`.
  ימים בלי משקל מוט → **לא מוסיפים רשומה**.
- `PER_MOVE_METCON` / `PER_MOVE_BOXES` / `PER_MOVE_SCORE` — רק אם רלוונטי
- `METCON_AMOUNT_LABEL` — לימי `amount`, שהתווית תהיה "חזרות" ולא מ׳/קל׳
- `METCON_RX_NOTE` — אם ל-RX יש משמעות ספציפית ביום

## שלב 5 · `PROGRAM_VERSION`

העלה ב-1 (שורה ~1997). **בלי זה מכשירים קיימים לא יקבלו את השבוע.**

**אל תיגע** ב-`BUILD` (boot.js) או ב-`version.json`. גרסת האפליקציה זזה רק
כשאורי נוקב במספר במפורש.

## שלב 6 · בדיקות

```bash
python -c "p='public/app.html';b=open(p,'rb').read();open(p,'wb').write(b.replace(b'\r\n',b'\n'))"
```

- נרמול CRLF ← **חובה** אחרי כל עריכה במחשב הזה
- בדיקת תקינות: `node --check` על boot.js אם נגעת בו
- ודא שכל 7 הימים קיימים ושאין `resultMode` חסר

## שלב 7 · יומן ודיווח

1. הוסף ל-`יומן-פרויקט.md` — כותרת `### 🏋️ הטמעת שבוע N — WEEK N, ‏תאריכים (תאריך) — PROGRAM_VERSION X`,
   ואז בעברית פשוטה: מה הוטמע, החלטות `resultMode` לא-טריוויאליות ולמה.
2. דווח לאורי: מה הוטמע, ה-`PROGRAM_VERSION` החדש, **ושאל אם לדחוף גרסה**.

---

## ⚠️ כללי ברזל

- **אל תוסיף תוכן שאורי לא שלח.** לא אימונים, לא הערות אימון, לא "שיפורים".
  *"אם אין בתוכנית ששלחתי לך אל תוסיף"* (03/09/2026).
  מותר: מכניקת אפליקציה שכבר מופיעה מילה-במילה בשבועות קודמים.
- **אל תשנה `resultMode` בשבוע סגור.**
- **הטמע לפני יום ראשון של אותו שבוע** — איחור = כל הרוסטר נעול על "COMING SOON".
