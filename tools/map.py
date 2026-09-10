#!/usr/bin/env python3
"""Section map of the two big source files. Run this INSTEAD of reading them.

    python tools/map.py                 app.html + boot.js
    python tools/map.py app             one file (app | boot)
    python tools/map.py app program     only sections whose name contains "program"

Then read ONE section:   sed -n "START,ENDp" public/app.html

Anchor grammar (add one whenever you add a new region):
    HTML   <!-- ==== SECTION: name ==== -->
    HTML   <!-- ---- name ---- -->            (sub-section inside the template)
    JS     // ---- name ----                    (one line; trailing dashes optional)
    JS     // ======  /  // name  /  // ======   (block banner)
"""
import io, os, re, sys

sys.stdout.reconfigure(encoding="utf-8")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FILES = {"app": "public/app.html", "boot": "public/assets/js/boot.js"}
RE_HTML = re.compile(r"^\s*<!--\s*={3,}\s*(?:SECTION:\s*)?(.+?)\s*={3,}\s*-->")
RE_HSUB = re.compile(r"^\s*<!--\s*-{4,}\s*(.+?)\s*-{3,}\s*-->")
RE_JS = re.compile(r"^\s*//\s*-{4,}\s*(.+?)\s*$")
RE_EQ = re.compile(r"^\s*//\s*={6,}\s*$")


def clean(name):
    name = re.sub(r"\s*-{3,}\s*$", "", name).strip()
    cut = name.find(". ")
    if cut > 12:
        name = name[:cut]
    return name[:76]


def anchors(lines):
    out, i = [], 0
    while i < len(lines):
        l = lines[i]
        m = RE_HTML.match(l)
        if m:
            out.append((i + 1, "H", clean(m.group(1))))
            i += 1
            continue
        m = RE_HSUB.match(l)
        if m:
            out.append((i + 1, "J", clean(m.group(1))))
            i += 1
            continue
        if RE_EQ.match(l):
            j, name = i + 1, ""
            while j < len(lines) and lines[j].lstrip().startswith("//") and not RE_EQ.match(lines[j]):
                if not name:
                    name = lines[j].lstrip()[2:].strip()
                j += 1
            out.append((i + 1, "J", clean(name) or "(unnamed block)"))
            i = j + 1
            continue
        m = RE_JS.match(l)
        if m:
            name = clean(m.group(1))
            if name and set(name) != {"-"}:
                out.append((i + 1, "J", name))
        i += 1
    return out


def show(key, needle):
    path = os.path.join(ROOT, FILES[key])
    lines = io.open(path, encoding="utf-8").read().split("\n")
    total = len(lines) - (1 if lines and lines[-1] == "" else 0)
    print("== %s — %d lines, %dKB ==" % (FILES[key], total, os.path.getsize(path) // 1024))
    a = anchors(lines)
    for n, (start, kind, name) in enumerate(a):
        nxt = [x for x in a[n + 1:] if kind == "J" or x[1] == "H"]
        end = nxt[0][0] - 1 if nxt else total
        if needle and needle not in name.lower():
            continue
        pad = "" if kind == "H" else "    "
        print("%s%5d-%-5d %4d  %s" % (pad, start, end, end - start + 1, name))


args = sys.argv[1:]
keys = [k for k in args if k in FILES] or list(FILES)
needle = " ".join(x for x in args if x not in FILES).lower()
for k in keys:
    show(k, needle)
print("read a section:  sed -n \"START,ENDp\" <file>")
