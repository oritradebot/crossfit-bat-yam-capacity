#!/usr/bin/env python3
"""Read the project journal (יומן-פרויקט.md) the cheap way.

    python tools/journal_tail.py            -> size, last 8 headings, last entry in full, open section
    python tools/journal_tail.py 3          -> same, but the last 3 entries in full
    python tools/journal_tail.py --headings -> only the numbered list of all entry headings
    python tools/journal_tail.py --open     -> only the open / next-up section

Never cat the journal: it is 100KB+ of Hebrew and grows every session.
"""
import io, os, sys

sys.stdout.reconfigure(encoding="utf-8")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
J = os.path.join(ROOT, "יומן-פרויקט.md")
if not os.path.exists(J):
    cands = [f for f in os.listdir(ROOT) if "יומן" in f and f.endswith(".md")]
    if not cands:
        sys.exit("journal not found in " + ROOT)
    J = os.path.join(ROOT, cands[0])

lines = io.open(J, encoding="utf-8").read().split("\n")
if lines and lines[-1] == "":
    lines.pop()
heads = [i for i, l in enumerate(lines) if l.startswith("### ")]
secs = [i for i, l in enumerate(lines) if l.startswith("## ")]
open_at = next((s for s in secs if lines[s].startswith("## פתוח")), None)

n, mode = 1, "tail"
for a in sys.argv[1:]:
    if a == "--headings":
        mode = "headings"
    elif a == "--open":
        mode = "open"
    elif a.isdigit():
        n = max(1, int(a))

print("%s — %d שורות, %dKB, %d רשומות" % (os.path.basename(J), len(lines), os.path.getsize(J) // 1024, len(heads)))

if mode == "headings":
    for i in heads:
        print("%d: %s" % (i + 1, lines[i][4:]))
    sys.exit()

if mode == "tail":
    print("--- הרשומות האחרונות (שורה: כותרת) ---")
    for i in heads[-8:]:
        print("%d: %s" % (i + 1, lines[i][4:]))
    if heads:
        start = heads[-n] if n <= len(heads) else heads[0]
        end = next((s for s in secs if s > start), len(lines))
        print("--- %d רשומות אחרונות במלואן (שורות %d-%d) ---" % (n, start + 1, end))
        print("\n".join(lines[start:end]).rstrip())

if open_at is not None:
    print("--- פתוח / הבא בתור (משורה %d) ---" % (open_at + 1))
    print("\n".join(lines[open_at:]).rstrip())
