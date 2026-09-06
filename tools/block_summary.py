# -*- coding: utf-8 -*-
"""
Block summary builder — CrossFit Bat Yam · Capacity Tracker
============================================================
Reads ONE admin backup file (the JSON the panel's "💾 גיבוי לקובץ" button
downloads, format "cfby-backup") and writes, without touching the cloud:

  <out>/
    README.txt                       what is here + how to restore
    <backup>.json                    a copy of the backup it was built from
    index.html                       roster overview (one row per member)
    all-sessions.csv                 every logged session, all members (Excel)
    participants/<name>/
        סיכום.html                   readable personal summary (print → PDF)
        backup.json                  this member only, restorable via ♻️ שחזור
        recap-card.json              the exact object the share card draws

Everything is derived the same way the app derives it (dayComplete,
metconScore, the CapaciTest slots of recap-build.js, heaviest-lift PRs) so
the numbers match what the athlete sees on screen. Nothing is invented: a
day without a log simply does not appear.

Usage:
  python tools/block_summary.py <backup.json> <out_dir>
"""
import csv
import html
import json
import os
import re
import shutil
import sys
from datetime import date, datetime, timedelta

START = date(2026, 7, 12)          # app.html: startDate = new Date(2026, 6, 12)
WEEKLY_TARGET = 5                  # app.html WEEKLY_TARGET; myTarget is never synced to the cloud
HE_DOW = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת']

# recap-build.js CAPACITESTS — same slots, same directions
CAPACITESTS = [
    dict(key='squat', name='Back Squat — שלשה כבדה', short='כוח רגליים', unit='ק"ג', better='higher',
         base=(0, 0, 'lift.weight'), retest=(7, 0, 'lift.weight')),
    dict(key='aerobic', name='מבחן אירובי — 3 סבבים', short='סיבולת אירובית', unit='', better='lower',
         base=(0, 1, 'metcon'), retest=(7, 1, 'metcon')),
    dict(key='strictpull', name='Strict Pull Up — 10 סטים ב־5:00', short='משיכה בשליטה', unit='חזרות', better='higher',
         base=(0, 1, 'extra0'), retest=(7, 1, 'extra0')),
    dict(key='c2b', name='C2B/Pull Ups — חזרות לדקה', short="ג'ימנסטיקה", unit='לדקה', better='higher',
         base=(0, 4, 'lift.reps'), retest=None),
]


# ---------------------------------------------------------------- helpers ---
def esc(s):
    return html.escape('' if s is None else str(s))


def num(s):
    try:
        v = float(str(s).strip())
        return v if v == v else None
    except Exception:
        return None


def trim_num(n):
    r = round(n * 10) / 10
    return str(int(r)) if r == int(r) else str(r)


def mmss(sec):
    m, s = int(sec // 60), int(round(sec % 60))
    return '%d:%02d' % (m, s)


def date_at(i):
    return START + timedelta(days=i)


def dmy(d):
    return d.strftime('%d/%m/%Y')


def day_complete(day):
    return bool(day and (day.get('done') or ((day.get('alt') or {}).get('done'))))


def day_has_pr(d):
    return bool(d and (d.get('pr') or d.get('rating') == 'pr'))


def rpe(day):
    k = str((day or {}).get('rating') or '').strip()
    return int(k) if k.isdigit() and 1 <= int(k) <= 10 else None


def metcon_score(m):
    """app.html metconScore: time → seconds (low=better); amount → number;
    rounds/reps → rounds*100000+reps (high=better). None when nothing logged."""
    if not m:
        return None
    M = m.get('log') or {}
    mode = m.get('resultMode') or M.get('mode') or 'time'
    if mode == 'time':
        t = str(M.get('time') or '').strip()
        if not t:
            return None
        try:
            p = [float(x) for x in t.split(':')]
        except ValueError:
            return None
        s = p[0] * 3600 + p[1] * 60 + p[2] if len(p) == 3 else (p[0] * 60 + p[1] if len(p) == 2 else p[0])
        return {'v': s, 'dir': 'low'} if s > 0 else None
    if mode == 'amount':
        a = num(M.get('amount'))
        return {'v': a, 'dir': 'high'} if a and a > 0 else None
    r = int(num(M.get('rounds')) or 0) * 100000 + int(num(M.get('reps')) or 0)
    return {'v': r, 'dir': 'high'} if r > 0 else None


def metcon_logged(m):
    M = (m or {}).get('log') or {}
    return bool(M.get('time') or M.get('amount') or M.get('rounds') or M.get('reps'))


def metcon_present(m):
    return bool(m and (m.get('name') or m.get('scheme') or m.get('note') or
                       any(x.get('name') or x.get('detail') for x in (m.get('movements') or []))))


def metcon_result_text(m):
    """Human text of a metcon log, honouring the scoring mode the way the card does."""
    sc = metcon_score(m)
    M = (m or {}).get('log') or {}
    if not sc:
        # logged under another mode? show whatever is there
        bits = []
        if M.get('time'):
            bits.append(str(M['time']))
        if M.get('rounds') or M.get('reps'):
            bits.append(' + '.join([x for x in [(str(M['rounds']) + ' סיבובים') if M.get('rounds') else '',
                                                (str(M['reps']) + ' חזרות') if M.get('reps') else ''] if x]))
        if M.get('amount'):
            bits.append(str(M['amount']))
        return ' · '.join(bits)
    if sc['dir'] == 'low':
        return mmss(sc['v'])
    mode = m.get('resultMode') or M.get('mode') or 'time'
    if mode == 'amount':
        return trim_num(sc['v'])
    r, x = divmod(int(sc['v']), 100000)
    return ('%d סיבובים' % r if r else '') + (' + ' if r and x else '') + ('%d חזרות' % x if x else '')


def lift_sets(L):
    """Per-set pilot fields s1..sN in order."""
    keys = sorted([k for k in L if re.match(r'^s\d+$', k) and str(L[k]).strip()], key=lambda k: int(k[1:]))
    return [(int(k[1:]), str(L[k]).strip()) for k in keys]


def lift_text(lift):
    L = (lift or {}).get('log') or {}
    parts = []
    if L.get('weight'):
        parts.append(str(L['weight']) + ' ק"ג')
    if L.get('reps'):
        parts.append(str(L['reps']) + ' חזרות')
    sets = lift_sets(L)
    if sets:
        parts.append('סטים: ' + ' | '.join('%s' % v for _, v in sets))
    return ' × '.join(parts[:2]) + ((' · ' + parts[2]) if len(parts) > 2 else '')


def session_logged(s):
    """Anything at all logged in this session (main day or alt)."""
    if not s:
        return False
    L = (s.get('lift') or {}).get('log') or {}
    if L.get('weight') or L.get('reps') or lift_sets(L) or (L.get('note') or '').strip():
        return True
    if metcon_logged(s.get('metcon')) or metcon_logged(s.get('metcon2')):
        return True
    if any(((e.get('log') or {}).get('text') or '').strip() for e in (s.get('extras') or [])):
        return True
    if (s.get('summary') or '').strip() or s.get('done') or s.get('pr') or rpe(s):
        return True
    return False


# ------------------------------------------------------- recap-build port ---
def read_slot(weeks, slot, test):
    if not slot:
        return None
    wi, di, src = slot
    try:
        day = weeks[wi]['days'][di]
    except (IndexError, KeyError, TypeError):
        return None
    if src == 'lift.weight':
        n = num(((day.get('lift') or {}).get('log') or {}).get('weight'))
        return {'v': n, 'text': trim_num(n) + ' ' + test['unit']} if n and n > 0 else None
    if src == 'lift.reps':
        n = num(((day.get('lift') or {}).get('log') or {}).get('reps'))
        return {'v': int(n), 'text': str(int(n))} if n and n > 0 else None
    if src in ('metcon', 'metcon2'):
        m = day.get(src)
        sc = metcon_score(m)
        if not sc:
            return None
        M = (m or {}).get('log') or {}
        if sc['dir'] == 'low':
            txt = mmss(sc['v'])
        elif (M.get('mode') == 'rounds' or (m or {}).get('resultMode') == 'rounds') and sc['v'] >= 100000:
            txt = '%d+%d' % divmod(int(sc['v']), 100000)
        else:
            txt = trim_num(sc['v'])
        return {'v': sc['v'], 'text': txt}
    if src.startswith('extra'):
        e = (day.get('extras') or [None] * 2)[int(src[5:])] if len(day.get('extras') or []) > int(src[5:]) else None
        t = ((e or {}).get('log') or {}).get('text') or ''
        mt = re.match(r'\s*(\d+)', str(t))
        n = int(mt.group(1)) if mt else 0
        return {'v': n, 'text': str(n)} if n > 0 else None
    return None


def build_test(weeks, t):
    b = read_slot(weeks, t['base'], t)
    if not b:
        return None
    a = read_slot(weeks, t['retest'], t)
    row = dict(key=t['key'], name=t['name'], short=t['short'], betterWhen=t['better'], unit=t['unit'],
               before=b['text'], after=a['text'] if a else '', beforePct=100, afterPct=0,
               delta='', deltaAbs='', gain=None, retested=bool(a), has_retest_slot=t['retest'] is not None)
    if not a:
        return row
    mx = max(b['v'], a['v'])
    row['beforePct'] = round(b['v'] / mx * 100)
    row['afterPct'] = round(a['v'] / mx * 100)
    if t['better'] == 'lower':
        faster = b['v'] - a['v']
        row['gain'] = faster / b['v'] if b['v'] > 0 else 0
        row['delta'] = ('מהיר ב־%d%%' % round(row['gain'] * 100)) if faster > 0 else ('איטי ב־%d%%' % abs(round(row['gain'] * 100)))
        row['deltaAbs'] = mmss(abs(faster))
    else:
        up = a['v'] - b['v']
        row['gain'] = up / b['v'] if b['v'] > 0 else 0
        row['delta'] = ('+' if up >= 0 else '') + '%d%%' % round(row['gain'] * 100)
        row['deltaAbs'] = ('+' if up >= 0 else '') + trim_num(up) + ((' ' + t['unit']) if t['unit'] else '')
    return row


def attendance(weeks, target=WEEKLY_TARGET):
    out, done, best, run, full, by_dow = [], 0, 0, 0, 0, [0] * 7
    for w in range(8):
        c = 0
        for d in range(7):
            dd = weeks[w]['days'][d] if w < len(weeks) and d < len(weeks[w]['days']) else None
            if day_complete(dd):
                c += 1
                run += 1
                best = max(best, run)
                by_dow[d] += 1
            else:
                run = 0
        c = min(target, c)
        out.append(c)
        done += c
        if c >= target:
            full += 1
    return dict(weeks=out, done=done, of=target * 8, target=target, best=best, fullWeeks=full, byDow=by_dow)


def rx_count(weeks):
    n = 0
    for w in weeks:
        for dd in w['days']:
            for m in (dd.get('metcon'), dd.get('metcon2')):
                if m and m.get('rx') and metcon_score(m):
                    n += 1
    return n


def personal_records(weeks, top=None):
    best = {}
    for wi, w in enumerate(weeks):
        for di, dd in enumerate(w['days']):
            for x in (dd, dd.get('alt')):
                if not x or not x.get('lift'):
                    continue
                name = (x['lift'].get('movement') or '').split('—')[0].strip()
                wt = num((x['lift'].get('log') or {}).get('weight'))
                if not name or not wt or wt <= 0:
                    continue
                k = name.lower()
                if k not in best or wt > best[k]['wt']:
                    best[k] = dict(name=name, wt=wt, pr=day_has_pr(x), week=wi + 1, dow=di,
                                   reps=(x['lift'].get('log') or {}).get('reps') or '')
    rows = sorted(best.values(), key=lambda e: (-int(e['pr']), -e['wt']))
    return rows[:top] if top else rows


def badges(att, rx, tests):
    out = []
    if att['best'] >= 5:
        out.append(dict(icon='🔥', name='רצף ברזל', value='%d ימים רצופים' % att['best']))
    if rx >= 8:
        out.append(dict(icon='⚡', name='RX ללא פשרות', value='%d מטקונים בתקן' % rx))
    if att['fullWeeks'] >= 2:
        out.append(dict(icon='💎', name='שבוע מושלם', value='%d שבועות של %d/%d' % (att['fullWeeks'], att['target'], att['target'])))
    improved = [t for t in tests if t['gain'] is not None and t['gain'] > 0]
    if improved and len(improved) == len(tests):
        out.append(dict(icon='📈', name='קו עולה', value='כל המבחנים השתפרו'))
    return out[:3]


def keep_list(att, rx, tests):
    out = []
    if att['fullWeeks'] >= 2:
        out.append(('עקביות', '%d שבועות מלאים מתוך 8' % att['fullWeeks']))
    imp = sorted([t for t in tests if t['gain'] is not None and t['gain'] > 0], key=lambda t: -t['gain'])
    if imp:
        top = imp[0]
        amount = re.sub(r'^\+', '', str(top['deltaAbs']))
        out.append((top['short'], top['name'].split('—')[0].strip() + ' ' + ('ירד ב־' if top['betterWhen'] == 'lower' else 'עלה ב־') + amount))
    if rx >= 8:
        out.append(('משמעת RX', '%d מטקונים בתקן המלא' % rx))
    if att['best'] >= 5:
        out.append(('רצף', '%d ימי אימון רצופים' % att['best']))
    if not out:
        out.append(('נוכחות', '%d אימונים מתוך %d' % (att['done'], att['of'])))
    return out[:3]


def improve_list(att, tests):
    out = []
    measured = [t for t in tests if t['after']]
    if len(measured) > 1:
        weakest = sorted(measured, key=lambda t: t['gain'])[0]
        out.append((weakest['short'], 'שיפור של %s — הקטן מבין %d המבחנים' % (weakest['deltaAbs'], len(measured))))
    unmeasured = [t for t in tests if not t['after']]
    if unmeasured:
        out.append(('לסגור מדידה', '%d מבחנים מחכים לרי-טסט' % len(unmeasured)))
    worst, worst_n = -1, 99
    for d, n in enumerate(att['byDow']):
        if d < 5 and n < worst_n:
            worst_n, worst = n, d
    if worst >= 0 and worst_n < 8:
        out.append(('נוכחות ב' + HE_DOW[worst], '%d מתוך 8 שבועות' % worst_n))
    lw = 0
    for w, n in enumerate(att['weeks']):
        if n < att['weeks'][lw]:
            lw = w
    if att['weeks'][lw] < att['target']:
        out.append(('השבוע החלש', 'שבוע %d — %d מתוך %d' % (lw + 1, att['weeks'][lw], att['target'])))
    return out[:3]


def build_recap(weeks, athlete):
    """Port of BlockRecap.build — the object the share card draws."""
    att = attendance(weeks)
    rx = rx_count(weeks)
    tests = [t for t in (build_test(weeks, t) for t in CAPACITESTS) if t]
    measured = [t for t in tests if t['after']]
    improved = [t for t in measured if t['gain'] is not None and t['gain'] > 0]
    thin = att['done'] < 5
    champ = sorted(improved, key=lambda t: -t['gain'])[0] if improved else None
    if thin or not champ:
        hero = dict(eyebrow='יומן אימונים', pct=str(att['done']), lead='תועדו בבלוק', leadShort='תועדו',
                    label='מתוך %d מתוכננים' % att['of'], before='', after='')
    else:
        hero = dict(eyebrow='השיפור הגדול ביותר',
                    pct=('-%d%%' % round(champ['gain'] * 100)) if champ['betterWhen'] == 'lower' else ('+%d%%' % round(champ['gain'] * 100)),
                    lead='הקפיצה של הבלוק', leadShort='הקפיצה של הבלוק', label=champ['name'],
                    before=champ['before'], after=champ['after'], unit=champ['unit'])
    if not tests:
        summary = ''
    elif len(measured) == len(tests) and len(improved) == len(tests):
        summary = '✓ כל %d המבחנים השתפרו' % len(tests)
    else:
        summary = 'נמדדו שוב · %d מתוך %d' % (len(measured), len(tests))
    prs3 = [dict(name=e['name'], value=trim_num(e['wt']) + ' ק"ג') for e in personal_records(weeks, 3)]
    return dict(
        logo='assets/logo.png', athlete=(athlete or '').strip(), program='CAPACITY PROGRAM · 8 WEEKS',
        dateRange=dmy(date_at(0)) + ' – ' + dmy(date_at(55)), hero=hero,
        badges=[] if thin else badges(att, rx, tests), tests=tests, testsSummary=summary,
        attendance=dict(weeks=att['weeks'], done=att['done'], of=att['of'], target=att['target']),
        keep=[dict(title=a, detail=b) for a, b in keep_list(att, rx, tests)],
        improve=[dict(title=a, detail=b) for a, b in improve_list(att, tests)],
        prs=prs3, trackedPct='%d%% מהבלוק תועד' % round(att['done'] / att['of'] * 100),
        _rx=rx, _att=att)


# ------------------------------------------------------------ categories ---
def age_from(bd, today):
    if not bd:
        return None
    b = datetime.strptime(bd, '%Y-%m-%d').date()
    a = today.year - b.year - ((today.month, today.day) < (b.month, b.day))
    return a


def category_of(gender, bd, today):
    if not gender or not bd:
        return None
    a = age_from(bd, today)
    bracket = 'teen' if a < 18 else ('elite' if a < 35 else 'masters')
    return bracket + ' ' + ('women' if gender == 'female' else 'men')


CAT_LABELS = {'teen men': 'TEEN · גברים', 'teen women': 'TEEN · נשים', 'elite men': 'ELITE · גברים',
              'elite women': 'ELITE · נשים', 'masters men': 'MASTERS · גברים', 'masters women': 'MASTERS · נשים'}


# ------------------------------------------------------------------ HTML ---
CSS = """
*{box-sizing:border-box} body{margin:0;background:#eef1f7;color:#14203d;font-family:'Heebo','Segoe UI',system-ui,Arial,sans-serif;direction:rtl;line-height:1.5}
.wrap{max-width:980px;margin:0 auto;padding:24px 18px 60px}
header.hd{background:linear-gradient(135deg,#0f1830,#23409a);color:#fff;border-radius:18px;padding:26px 28px;margin-bottom:22px;box-shadow:0 10px 30px rgba(15,24,48,.25)}
header.hd h1{margin:0 0 4px;font-size:30px;font-weight:800} header.hd .sub{color:#b9c6ea;font-size:14px} header.hd .meta{margin-top:12px;display:flex;flex-wrap:wrap;gap:8px}
.chip{display:inline-block;background:rgba(255,255,255,.14);border:1px solid rgba(255,255,255,.22);border-radius:999px;padding:4px 12px;font-size:13px;color:#fff}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:22px}
.tile{background:#fff;border-radius:14px;padding:14px 16px;box-shadow:0 2px 10px rgba(15,24,48,.06)} .tile .v{font-size:30px;font-weight:800;color:#23409a;line-height:1.1} .tile .l{font-size:12px;color:#5a6580;margin-top:4px}
section{background:#fff;border-radius:16px;padding:18px 20px;margin-bottom:18px;box-shadow:0 2px 10px rgba(15,24,48,.06)}
section h2{margin:0 0 12px;font-size:19px;font-weight:800;color:#0f1830;border-bottom:2px solid #eef1f7;padding-bottom:8px}
table{width:100%;border-collapse:collapse;font-size:14px} th,td{padding:7px 9px;text-align:right;border-bottom:1px solid #eef1f7;vertical-align:top} th{color:#5a6580;font-weight:700;font-size:12px;background:#f7f8fc}
.ok{color:#2a9d52;font-weight:700} .bad{color:#c9402f;font-weight:700} .muted{color:#7a86a0} .small{font-size:12px}
.week{margin-bottom:14px} .week h3{margin:14px 0 6px;font-size:16px;color:#23409a}
.day{border:1px solid #e6eaf3;border-radius:12px;padding:10px 14px;margin:8px 0;background:#fbfcfe}
.day.done{border-color:#bfe3cc;background:#f3fbf6} .day .top{display:flex;flex-wrap:wrap;gap:8px;align-items:center;font-weight:700}
.tag{display:inline-block;border-radius:999px;padding:2px 10px;font-size:12px;font-weight:700} .tag.done{background:#d9f3e2;color:#1f7a41} .tag.part{background:#fff1d6;color:#9a5b00} .tag.rest{background:#e7e9f0;color:#4a5570} .tag.pr{background:#fde9c3;color:#8a5a00} .tag.rx{background:#dde6ff;color:#23409a} .tag.sc{background:#f0e6ff;color:#5a2ea6} .tag.rpe{background:#e7e9f0;color:#31405f}
.row{display:grid;grid-template-columns:110px 1fr;gap:8px;padding:5px 0;border-top:1px dashed #e6eaf3;font-size:14px} .row .k{color:#5a6580;font-size:12px;font-weight:700;padding-top:2px} .row .val b{color:#0f1830}
.note{color:#5a6580;font-size:12px;white-space:pre-wrap}
.bar{height:10px;border-radius:999px;background:#e6eaf3;overflow:hidden;margin-top:4px} .bar i{display:block;height:100%;background:linear-gradient(90deg,#3fbf6a,#23409a)}
.att{display:grid;grid-template-columns:repeat(8,1fr);gap:6px;text-align:center} .att div{background:#f7f8fc;border-radius:10px;padding:8px 4px} .att .n{font-size:22px;font-weight:800;color:#23409a} .att .w{font-size:11px;color:#5a6580}
ul.clean{margin:0;padding:0 18px 0 0} ul.clean li{margin:4px 0}
footer{color:#7a86a0;font-size:12px;text-align:center;margin-top:20px}
@media print{body{background:#fff} section,.tile,header.hd{box-shadow:none} .day{break-inside:avoid}}
"""


def page(title, body, sub=''):
    return ('<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
            '<title>%s</title><style>%s</style></head><body><div class="wrap">%s</div>%s</body></html>' % (esc(title), CSS, body, sub))


def session_html(s, label=None):
    """One session (the day itself or its endurance alt) as rows."""
    out = []
    if label:
        out.append('<div class="row"><div class="k">%s</div><div class="val muted small">סשן חלופי (אינדורנס)</div></div>' % esc(label))
    lift = s.get('lift') or {}
    L = lift.get('log') or {}
    if lift.get('movement') or L.get('weight') or L.get('reps') or lift_sets(L):
        val = '<b>%s</b>' % esc(lift.get('movement') or 'כוח')
        lt = lift_text(lift)
        if lt:
            val += ' — ' + esc(lt)
        if (L.get('note') or '').strip():
            val += '<div class="note">%s</div>' % esc(L['note'])
        out.append('<div class="row"><div class="k">🏋️ כוח</div><div class="val">%s</div></div>' % val)
    for key, lab in (('metcon', '⏱️ מטקון'), ('metcon2', '⏱️ מטקון B')):
        m = s.get(key)
        if not m or not (metcon_present(m) or metcon_logged(m)):
            continue
        if not metcon_logged(m):
            continue
        tags = ''
        if m.get('rx'):
            tags += ' <span class="tag rx">RX</span>'
        if m.get('scaled'):
            tags += ' <span class="tag sc">Scaled</span>'
        head = ' · '.join([x for x in [m.get('name'), m.get('scheme')] if x])
        val = '<b>%s</b>%s<div>תוצאה: <b>%s</b>%s</div>' % (
            esc(head or 'מטקון'), tags, esc(metcon_result_text(m)),
            (' <span class="muted small">(%s)</span>' % esc(m.get('score'))) if m.get('score') else '')
        M = m.get('log') or {}
        if (M.get('scaled') or '').strip():
            val += '<div class="note">התאמה: %s</div>' % esc(M['scaled'])
        if (M.get('note') or '').strip():
            val += '<div class="note">%s</div>' % esc(M['note'])
        out.append('<div class="row"><div class="k">%s</div><div class="val">%s</div></div>' % (lab, val))
    for i, e in enumerate(s.get('extras') or []):
        t = ((e.get('log') or {}).get('text') or '').strip()
        if t:
            out.append('<div class="row"><div class="k">➕ תוספת</div><div class="val"><b>%s</b> — %s</div></div>' % (esc(e.get('name') or 'תוספת %d' % (i + 1)), esc(t)))
    if (s.get('summary') or '').strip():
        out.append('<div class="row"><div class="k">📝 סיכום</div><div class="val note">%s</div></div>' % esc(s['summary']))
    return ''.join(out)


def day_html(wi, di, dd):
    d = date_at(wi * 7 + di)
    main_logged = session_logged({k: v for k, v in dd.items() if k != 'alt'})
    alt = dd.get('alt')
    alt_logged = session_logged(alt)
    if not (main_logged or alt_logged or dd.get('rest')):
        return ''
    done = day_complete(dd)
    tags = []
    if done:
        tags.append('<span class="tag done">✅ הושלם</span>')
    elif dd.get('rest'):
        tags.append('<span class="tag rest">😴 מנוחה</span>')
    else:
        tags.append('<span class="tag part">📝 הזנה חלקית</span>')
    if day_has_pr(dd) or day_has_pr(alt):
        tags.append('<span class="tag pr">🏆 PR</span>')
    r = rpe(dd) or rpe(alt)
    if r:
        tags.append('<span class="tag rpe">RPE %d</span>' % r)
    body = ''
    if main_logged:
        body += session_html(dd)
    if alt_logged:
        body += session_html(alt, 'אינדורנס')
    return ('<div class="day%s"><div class="top"><span>יום %s · %s</span> %s</div>%s</div>'
            % (' done' if done else '', HE_DOW[di], d.strftime('%d/%m'), ' '.join(tags), body))


def tests_table(tests):
    if not tests:
        return '<p class="muted">לא תועדו מבחני CapaciTest בשבוע 1.</p>'
    rows = []
    for t in tests:
        if t['after']:
            good = (t['gain'] or 0) > 0
            delta = '<span class="%s">%s (%s)</span>' % ('ok' if good else 'bad', esc(t['delta']), esc(t['deltaAbs']))
        else:
            delta = '<span class="muted">לא נמדד שוב</span>' if t['has_retest_slot'] else '<span class="muted">אין מדידה חוזרת בתוכנית</span>'
        rows.append('<tr><td><b>%s</b><div class="small muted">%s</div></td><td dir="ltr" style="text-align:right">%s</td><td dir="ltr" style="text-align:right">%s</td><td>%s</td></tr>'
                    % (esc(t['name']), esc(t['short']), esc(t['before']), esc(t['after'] or '—'), delta))
    return '<table><tr><th>מבחן</th><th>שבוע 1</th><th>שבוע 8</th><th>שינוי</th></tr>%s</table>' % ''.join(rows)


def member_page(p, st, bd, recap, weeks, today, backup_created):
    name = (bd or {}).get('name') or p.get('name') or p.get('email') or p['id']
    att = recap['_att']
    cat = category_of(p.get('gender'), p.get('birth_date'), today)
    meta = [('👤 ' + esc(p.get('email') or '')), ('🏷️ ' + esc(CAT_LABELS.get(cat, cat or '—')))]
    if p.get('birth_date'):
        meta.append('🎂 %s (גיל %s)' % (esc(datetime.strptime(p['birth_date'], '%Y-%m-%d').strftime('%d/%m/%Y')), age_from(p['birth_date'], today)))
    meta.append('📅 נרשם/ה %s' % esc('/'.join(p['created_at'][:10].split('-')[::-1])))
    if st:
        meta.append('☁️ עדכון אחרון בענן %s' % esc(fmt_ts(st['updated_at'])))
    else:
        meta.append('⚠️ אין שורת תוצאות בענן')
    raw_sessions = sum(1 for w in weeks for dd in w['days'] for s in (dd, dd.get('alt')) if s and s.get('done'))
    tiles = [
        (att['done'], 'ימי אימון שהושלמו מתוך %d' % att['of']),
        ('%d%%' % round(att['done'] / att['of'] * 100), 'מהבלוק תועד'),
        (raw_sessions, 'סשנים שהושלמו (כולל אינדורנס)'),
        (att['best'], 'רצף ימים הכי ארוך'),
        (att['fullWeeks'], 'שבועות מלאים (%d/%d)' % (att['target'], att['target'])),
        (recap['_rx'], 'מטקונים RX'),
        (len(personal_records(weeks)), 'תרגילי כוח עם משקל מתועד'),
    ]
    tiles_html = ''.join('<div class="tile"><div class="v">%s</div><div class="l">%s</div></div>' % (esc(v), esc(l)) for v, l in tiles)
    att_html = ''.join('<div><div class="n">%d</div><div class="w">שבוע %d<br>%s</div></div>' % (n, i + 1, esc(date_at(i * 7).strftime('%d/%m'))) for i, n in enumerate(att['weeks']))
    hero = recap['hero']
    hero_html = '<p><b>%s:</b> %s %s — %s' % (esc(hero['eyebrow']), esc(hero['pct']), esc(hero['lead']), esc(hero['label']))
    if hero.get('before'):
        hero_html += ' (%s ← %s)' % (esc(hero['before']), esc(hero['after']))
    hero_html += '</p>'
    badges_html = ''.join('<li>%s <b>%s</b> — %s</li>' % (esc(b['icon']), esc(b['name']), esc(b['value'])) for b in recap['badges']) or '<li class="muted">לא נפתחו הישגים</li>'
    keep_html = ''.join('<li><b>%s</b> — %s</li>' % (esc(k['title']), esc(k['detail'])) for k in recap['keep'])
    imp_html = ''.join('<li><b>%s</b> — %s</li>' % (esc(k['title']), esc(k['detail'])) for k in recap['improve'])
    prs = personal_records(weeks)
    prs_html = ('<table><tr><th>תרגיל</th><th>משקל</th><th>חזרות</th><th>שבוע / יום</th><th></th></tr>' +
                ''.join('<tr><td>%s</td><td dir="ltr" style="text-align:right">%s ק"ג</td><td>%s</td><td>שבוע %d · %s</td><td>%s</td></tr>'
                        % (esc(e['name']), trim_num(e['wt']), esc(e['reps'] or '—'), e['week'], HE_DOW[e['dow']], '🏆 סומן PR' if e['pr'] else '')
                        for e in prs) + '</table>') if prs else '<p class="muted">לא תועדו משקלים בתרגילי כוח.</p>'
    log_html = ''
    n_days = 0
    for wi in range(8):
        days = ''.join(day_html(wi, di, weeks[wi]['days'][di]) for di in range(7))
        if days:
            n_days += days.count('<div class="day')
            log_html += '<div class="week"><h3>שבוע %d · %s — %s</h3>%s</div>' % (
                wi + 1, date_at(wi * 7).strftime('%d/%m'), date_at(wi * 7 + 6).strftime('%d/%m'), days)
    if not log_html:
        log_html = '<p class="muted">לא תועדו אימונים.</p>'
    body = (
        '<header class="hd"><h1>%s</h1><div class="sub">CAPACITY PROGRAM · 8 WEEKS · CrossFit Bat Yam · בלוק 1 · %s</div>'
        '<div class="meta">%s</div></header>' % (esc(name), esc(recap['dateRange']), ''.join('<span class="chip">%s</span>' % m for m in meta)) +
        '<div class="grid">%s</div>' % tiles_html +
        '<section><h2>נוכחות לאורך הבלוק</h2><div class="att">%s</div><p class="small muted">יעד שבועי: %d אימונים (יום נספר פעם אחת גם אם הושלמו שני סשנים).</p></section>' % (att_html, att['target']) +
        '<section><h2>מבחני CapaciTest — שבוע 1 מול שבוע 8</h2>%s<p class="small muted">%s</p></section>' % (tests_table(recap['tests']), esc(recap['testsSummary'])) +
        '<section><h2>הכרטיס בקצרה</h2>%s<h3 class="small">🏅 הישגים שנפתחו</h3><ul class="clean">%s</ul><h3 class="small">✅ לשימור</h3><ul class="clean">%s</ul><h3 class="small">🎯 לחיזוק בבלוק הבא</h3><ul class="clean">%s</ul></section>' % (hero_html, badges_html, keep_html, imp_html) +
        '<section><h2>🏆 שיאים אישיים — המשקל הכבד ביותר לכל תרגיל</h2>%s</section>' % prs_html +
        '<section><h2>📅 יומן האימונים המלא (%d ימים עם תיעוד)</h2>%s</section>' % (n_days, log_html) +
        '<footer>הופק מקובץ הגיבוי של %s · הנתונים נגזרים באותה דרך שהאפליקציה מחשבת אותם · לשחזור המתאמן/ת לענן: פאנל האדמין → ♻️ שחזור מגיבוי → backup.json שבתיקייה זו</footer>' % esc(fmt_ts(backup_created)))
    return page('סיכום בלוק 1 — ' + name, body)


def fmt_ts(iso):
    try:
        t = datetime.strptime(iso[:19], '%Y-%m-%dT%H:%M:%S') + timedelta(hours=3)   # UTC → Israel (summer)
        return t.strftime('%d/%m/%Y %H:%M')
    except Exception:
        return iso


def index_page(rows, backup, today):
    trs = []
    for r in rows:
        att = r['recap']['_att']
        tests = ' · '.join('%s: %s→%s' % (t['short'], t['before'], t['after'] or '—') for t in r['recap']['tests']) or '—'
        trs.append('<tr><td><a href="participants/%s/סיכום.html"><b>%s</b></a><div class="small muted">%s</div></td><td>%s</td><td>%s</td>'
                   '<td><b>%d</b>/%d</td><td dir="ltr" style="text-align:right;white-space:nowrap;font-family:monospace">%s</td><td>%d</td><td>%d</td><td class="small">%s</td><td class="small" style="white-space:nowrap">%s</td></tr>'
                   % (esc(r['folder']), esc(r['name']), esc(r['p'].get('email') or ''), esc(CAT_LABELS.get(r['cat'], r['cat'] or '—')),
                      'כן' if r['st'] else '<span class="bad">אין</span>', att['done'], att['of'],
                      ' '.join(str(n) for n in att['weeks']), len(personal_records(r['weeks'])), r['recap']['_rx'],
                      esc(tests), esc(fmt_ts(r['st']['updated_at'])) if r['st'] else '—'))
    body = ('<header class="hd"><h1>סיכום בלוק 1 — כל המשתתפים</h1><div class="sub">CAPACITY PROGRAM · 8 WEEKS · CrossFit Bat Yam · 12/07/2026 – 05/09/2026</div>'
            '<div class="meta"><span class="chip">📦 גיבוי מ-%s</span><span class="chip">👥 %d משתתפים</span><span class="chip">☁️ %d עם תוצאות בענן</span><span class="chip">גרסה %s</span></div></header>'
            % (esc(fmt_ts(backup['created_at'])), len(rows), sum(1 for r in rows if r['st']), esc(backup.get('build', ''))) +
            '<section><h2>המשתתפים</h2><table><tr><th>מתאמן/ת</th><th>קטגוריה</th><th>תוצאות בענן</th><th>אימונים</th><th>לפי שבוע (1→8)</th><th>תרגילי כוח</th><th>RX</th><th>מבחנים (ש1→ש8)</th><th>עדכון אחרון</th></tr>%s</table>'
            '<p class="small muted">לחיצה על שם פותחת את הסיכום האישי. בכל תיקיית משתתף: סיכום.html (לקריאה/הדפסה), backup.json (שחזור של המשתתף בלבד דרך ♻️ בפאנל), recap-card.json (נתוני כרטיס הסיכום).</p></section>' % ''.join(trs) +
            '<section><h2>מה יש בתיקייה</h2><ul class="clean"><li><b>%s</b> — הגיבוי המלא (כל 4 הטבלאות) שממנו הופק הכל. לשחזור מלא: פאנל האדמין → ♻️ שחזור מגיבוי.</li>'
            '<li><b>all-sessions.csv</b> — כל סשן שתועד, כל המשתתפים, שורה לכל סשן (לאקסל).</li><li><b>participants/</b> — תיקייה לכל משתתף.</li></ul></section>' % esc(backup['_file']))
    return page('סיכום בלוק 1 — כל המשתתפים', body)


# ------------------------------------------------------------------- CSV ---
CSV_HEAD = ['שם', 'משתמש', 'שבוע', 'יום', 'תאריך', 'סשן', 'הושלם', 'מנוחה', 'RPE', 'PR',
            'תרגיל כוח', 'משקל', 'חזרות', 'סטים', 'הערת כוח',
            'מטקון', 'סכמה', 'ניקוד לפי', 'תוצאה', 'RX', 'Scaled', 'התאמה', 'הערת מטקון',
            'מטקון B', 'תוצאה B', 'RX B', 'תוספת 1', 'תוספת 2', 'סיכום יום']


def csv_rows(name, user, weeks):
    for wi, w in enumerate(weeks):
        for di, dd in enumerate(w['days']):
            for label, s in (('ראשי', dd), ('אינדורנס', dd.get('alt'))):
                if not s or not session_logged({k: v for k, v in s.items() if k != 'alt'}):
                    if not (label == 'ראשי' and dd.get('rest')):
                        continue
                L = (s.get('lift') or {}).get('log') or {}
                m, m2 = s.get('metcon') or {}, s.get('metcon2') or {}
                ex = s.get('extras') or []
                yield [name, user, wi + 1, HE_DOW[di], date_at(wi * 7 + di).strftime('%d/%m/%Y'), label,
                       'כן' if s.get('done') else '', 'כן' if (label == 'ראשי' and dd.get('rest')) else '', rpe(s) or '',
                       'כן' if day_has_pr(s) else '',
                       (s.get('lift') or {}).get('movement') or '', L.get('weight') or '', L.get('reps') or '',
                       ' | '.join(v for _, v in lift_sets(L)), L.get('note') or '',
                       m.get('name') or '', m.get('scheme') or '', m.get('score') or '', metcon_result_text(m) if metcon_logged(m) else '',
                       'RX' if m.get('rx') else '', 'Scaled' if m.get('scaled') else '', (m.get('log') or {}).get('scaled') or '', (m.get('log') or {}).get('note') or '',
                       m2.get('name') or '', metcon_result_text(m2) if metcon_logged(m2) else '', 'RX' if m2.get('rx') else '',
                       ((ex[0].get('log') or {}).get('text') or '') if len(ex) > 0 else '',
                       ((ex[1].get('log') or {}).get('text') or '') if len(ex) > 1 else '',
                       s.get('summary') or '']


# ------------------------------------------------------------------ main ---
def empty_weeks():
    def mc():
        return dict(name='', scheme='', score='', note='', result='', resultMode='', rx=False, scaled=False,
                    log=dict(mode='time', time='', rounds='', reps='', amount='', note='', scaled=''), movements=[])
    return [dict(days=[dict(done=False, rest=False, rating='', pr=False, lift=dict(movement='', planned='', result='', log=dict(weight='', reps='', note='')),
                            metcon=mc(), metcon2=mc(), extras=[dict(name='', detail='', result='', log=dict(text='')) for _ in range(2)], summary='')
                       for _ in range(7)]) for _ in range(8)]


def safe_folder(name):
    s = re.sub(r'[\\/:*?"<>|]+', ' ', name).strip()
    return s or 'unknown'


def main(src, out):
    backup = json.load(open(src, encoding='utf-8'))
    if backup.get('format') != 'cfby-backup':
        sys.exit('not a cfby-backup file')
    today = date.today()
    backup['_file'] = os.path.basename(src)
    states = {s['user_id']: s for s in backup['states']}
    boards = {b['user_id']: b for b in backup['board']}
    os.makedirs(os.path.join(out, 'participants'), exist_ok=True)
    shutil.copy2(src, os.path.join(out, os.path.basename(src)))
    rows = []
    all_csv = []
    for p in sorted(backup['profiles'], key=lambda p: (not p['id'] in states, (p.get('name') or '').lower())):
        st, bd = states.get(p['id']), boards.get(p['id'])
        name = (bd or {}).get('name') or p.get('name') or p.get('email') or p['id']
        weeks = (st or {}).get('tracker', {}).get('weeks') if st else None
        if not weeks or len(weeks) < 8:
            weeks = (weeks or []) + empty_weeks()[len(weeks or []):]
        recap = build_recap(weeks, name)
        cat = category_of(p.get('gender'), p.get('birth_date'), today)
        folder = safe_folder(name)
        pdir = os.path.join(out, 'participants', folder)
        os.makedirs(pdir, exist_ok=True)
        with open(os.path.join(pdir, 'סיכום.html'), 'w', encoding='utf-8') as f:
            f.write(member_page(p, st, bd, recap, weeks, today, backup['created_at']))
        one = dict(format='cfby-backup', ver=1, created_at=backup['created_at'], build=backup.get('build'),
                   note='single-member slice of ' + backup['_file'] + ' — restorable via the admin panel (♻️)',
                   profiles=[p], states=[st] if st else [], board=[bd] if bd else [], shared_program=[])
        with open(os.path.join(pdir, 'backup.json'), 'w', encoding='utf-8') as f:
            json.dump(one, f, ensure_ascii=False)
        card = {k: v for k, v in recap.items() if not k.startswith('_')}
        card['username'] = p.get('email') or ''
        with open(os.path.join(pdir, 'recap-card.json'), 'w', encoding='utf-8') as f:
            json.dump(card, f, ensure_ascii=False, indent=1)
        all_csv.extend(csv_rows(name, p.get('email') or '', weeks))
        rows.append(dict(p=p, st=st, bd=bd, name=name, folder=folder, recap=recap, weeks=weeks, cat=cat))
        print('  %-22s done %2d/40  streak %2d  rx %2d  tests %d  logged-sessions %d' % (
            name, recap['_att']['done'], recap['_att']['best'], recap['_rx'], len(recap['tests']),
            sum(1 for r in all_csv if r[0] == name)))
    with open(os.path.join(out, 'index.html'), 'w', encoding='utf-8') as f:
        f.write(index_page(rows, backup, today))
    with open(os.path.join(out, 'all-sessions.csv'), 'w', encoding='utf-8-sig', newline='') as f:
        w = csv.writer(f)
        w.writerow(CSV_HEAD)
        w.writerows(all_csv)
    with open(os.path.join(out, 'README.txt'), 'w', encoding='utf-8') as f:
        f.write(README % dict(file=backup['_file'], when=fmt_ts(backup['created_at']), n=len(rows),
                              ns=sum(1 for r in rows if r['st']), build=backup.get('build', '')))
    print('written:', out)
    return rows


README = """סיכום בלוק 1 — CrossFit Bat Yam · Capacity Tracker
=====================================================
הופק מקובץ הגיבוי: %(file)s (נלקח %(when)s, גרסת אפליקציה %(build)s)
%(n)d משתתפים ברוסטר, %(ns)d מהם עם שורת תוצאות בענן.

מה יש כאן
---------
index.html            — טבלת כל המשתתפים עם קישור לסיכום האישי של כל אחד.
all-sessions.csv      — כל סשן שתועד, כל המשתתפים, שורה לכל סשן (נפתח באקסל).
participants/<שם>/   — תיקייה לכל משתתף:
    סיכום.html        — הסיכום האישי לקריאה (בדפדפן: Ctrl+P → שמירה כ-PDF).
    backup.json       — הנתונים הגולמיים של המשתתף בלבד (פרופיל + תוצאות + לוח),
                        בפורמט הגיבוי של האפליקציה. לשחזור של משתתף אחד:
                        פאנל האדמין → ♻️ שחזור מגיבוי → לבחור את הקובץ הזה.
    recap-card.json   — נתוני כרטיס הסיכום (מה שהכרטיס מצייר).
    recap-story.png / recap-feed.png — כרטיס הסיכום כתמונה (אם הופק).
%(file)s — עותק של הגיבוי המלא (4 טבלאות). לשחזור מלא של כל הענן:
                        פאנל האדמין → ♻️ שחזור מגיבוי → הקובץ הזה.

איך מפיקים מחדש (למשל אחרי גיבוי טרי לפני האיפוס)
-----------------------------------------------------
1. באפליקציה (מחשב, במצב מנהל): 👥 משתתפים → 💾 גיבוי לקובץ.
2. בטרמינל, מתיקיית הפרויקט:
   python tools/block_summary.py "<נתיב לקובץ הגיבוי>" "<תיקיית פלט>"
"""

BACKUP_DIR = r"C:\Users\leaan\Desktop\crossfit manager project\CFBY Capacity Dashboard"   # where Chrome drops the 💾 files


def newest_backup():
    import glob
    files = sorted(glob.glob(os.path.join(BACKUP_DIR, 'batyam-backup-*.json')), key=os.path.getmtime)
    return files[-1] if files else None


if __name__ == '__main__':
    src = sys.argv[1] if len(sys.argv) > 1 else newest_backup()
    if not src or not os.path.exists(src):
        sys.exit(__doc__)
    if len(sys.argv) > 2:
        out = sys.argv[2]
    else:   # same convention tools/recap_cards_server.py uses, so both land in one folder
        created = json.load(open(src, encoding='utf-8')).get('created_at', '')[:10]
        out = os.path.join(os.path.dirname(src), 'block1-summary-' + (created or 'latest'))
    print('backup:', src)
    main(src, out)
