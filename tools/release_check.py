#!/usr/bin/env python3
"""Pre-deploy checks for the Capacity Tracker. Run before every commit that goes to main:

    python tools/release_check.py

Exit code 0 = all green; every check prints a line with its reason. What it guards
(each one bit us at least once — see docs/domains/release.md and sync.md):

  1. version.json parses; its build == BUILD in boot.js; maintenance is true/false
  2. boot.js BLOCK == app.html BLOCK_NUM (a missed bump reopens the second-storage hole)
  3. no CRLF in tracked text files (Edit / checkout / merge write CRLF on this machine)
  4. PROGRAM_VERSION went up if the BLOCK 2 program text (programWeek1..8) differs from HEAD
  5. the two recap-card scripts in app.html are verbatim copies of design/block-recap/*.js
  6. iron rule 1: no .select() chained on an upsert in boot.js; iron rule 4: no assignment
     to localStorage.setItem (wrap Storage.prototype instead)
  7. no CDN script tags in public/*.html (supabase-js is self-hosted and pinned)
"""
import io, json, os, re, subprocess, sys

sys.stdout.reconfigure(encoding="utf-8")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APP = os.path.join(ROOT, "public", "app.html")
BOOT = os.path.join(ROOT, "public", "assets", "js", "boot.js")
VERSION = os.path.join(ROOT, "public", "version.json")
TEXT_EXT = {".html", ".js", ".md", ".json", ".sql", ".py", ".css", ".webmanifest", ".txt", ".csv"}

results = []


def ok(name, detail=""):
    results.append((True, name, detail))


def bad(name, detail=""):
    results.append((False, name, detail))


def read(path):
    with io.open(path, "r", encoding="utf-8", newline="") as f:
        return f.read().replace("\r\n", "\n")


def git(*args):
    r = subprocess.run(["git", *args], cwd=ROOT, capture_output=True)
    if r.returncode != 0:
        return None
    return r.stdout.decode("utf-8", "replace")


app = read(APP)
boot = read(BOOT)

# 1) version.json <-> BUILD ------------------------------------------------------
try:
    vj = json.loads(read(VERSION))
    m = re.search(r'var BUILD = "([^"]+)"', boot)
    build = m.group(1) if m else None
    if not build:
        bad("BUILD", "var BUILD not found in boot.js")
    elif vj.get("build") != build:
        bad("BUILD == version.json", "boot.js BUILD %s, version.json build %s" % (build, vj.get("build")))
    else:
        ok("BUILD == version.json", build)
    if not isinstance(vj.get("maintenance"), bool):
        bad("maintenance flag", "version.json maintenance must be true/false, got %r" % (vj.get("maintenance"),))
    else:
        ok("maintenance flag", "maintenance = %s" % ("true" if vj["maintenance"] else "false"))
except Exception as e:
    bad("version.json", str(e))

# 2) BLOCK <-> BLOCK_NUM ----------------------------------------------------------
mb = re.search(r"^\s*var BLOCK = (\d+);", boot, re.M)
mn = re.search(r"^\s*BLOCK_NUM = (\d+);", app, re.M)
if not mb or not mn:
    bad("BLOCK == BLOCK_NUM", "constant missing (boot.js BLOCK %s, app.html BLOCK_NUM %s)" % (bool(mb), bool(mn)))
elif mb.group(1) != mn.group(1):
    bad("BLOCK == BLOCK_NUM", "boot.js BLOCK %s, app.html BLOCK_NUM %s — bump both together" % (mb.group(1), mn.group(1)))
else:
    ok("BLOCK == BLOCK_NUM", "block " + mb.group(1))

# 3) CRLF in tracked text files ---------------------------------------------------
ls = git("ls-files", "-z")
if ls is None:
    bad("CRLF", "git ls-files failed")
else:
    offenders = []
    for rel in ls.split("\0"):
        if not rel or os.path.splitext(rel)[1].lower() not in TEXT_EXT:
            continue
        p = os.path.join(ROOT, rel)
        if not os.path.isfile(p):
            continue
        with open(p, "rb") as f:
            n = f.read().count(b"\r\n")
        if n:
            offenders.append("%s (%d)" % (rel, n))
    if offenders:
        bad("CRLF", "CRLF in: " + ", ".join(offenders[:8]) + (" …" if len(offenders) > 8 else "") +
            "  — normalize: python -c \"p='FILE';b=open(p,'rb').read();open(p,'wb').write(b.replace(b'\\r\\n',b'\\n'))\"")
    else:
        ok("CRLF", "all tracked text files are LF")

# 4) PROGRAM_VERSION vs program text ----------------------------------------------
def program_region(src):
    a = src.find("programWeek1() {")
    b = src.find("demoWeek1() {")
    if a < 0 or b < 0 or b < a:
        return None
    return src[a:b]


def program_version(src):
    m = re.search(r"^\s*PROGRAM_VERSION = (\d+);", src, re.M)
    return int(m.group(1)) if m else None


head_app = git("show", "HEAD:public/app.html")
if head_app is None:
    ok("PROGRAM_VERSION", "no HEAD copy of app.html to compare against (skipped)")
else:
    head_app = head_app.replace("\r\n", "\n")
    cur_r, old_r = program_region(app), program_region(head_app)
    cur_v, old_v = program_version(app), program_version(head_app)
    if cur_r is None or cur_v is None:
        bad("PROGRAM_VERSION", "could not locate programWeek1()/demoWeek1() or PROGRAM_VERSION in app.html")
    elif old_r is None or old_v is None:
        ok("PROGRAM_VERSION", "HEAD has no comparable program region (skipped)")
    elif cur_r != old_r and cur_v <= old_v:
        bad("PROGRAM_VERSION", "program text (programWeek1..8) changed vs HEAD but PROGRAM_VERSION is still %d — bump it or existing devices never get the change" % cur_v)
    elif cur_r != old_r:
        ok("PROGRAM_VERSION", "program text changed, PROGRAM_VERSION %d -> %d" % (old_v, cur_v))
    else:
        ok("PROGRAM_VERSION", "program text unchanged vs HEAD (PROGRAM_VERSION %d)" % cur_v)

# 5) recap card pasted verbatim ------------------------------------------------------
def pasted_block(src, anchor):
    i = src.find(anchor)
    if i < 0:
        return None
    s = src.find("\n<script>\n", i)
    e = src.find("\n</script>", s)
    if s < 0 or e < 0:
        return None
    return src[s + len("\n<script>\n"):e]


def first_diff(a, b):
    la, lb = a.split("\n"), b.split("\n")
    for i, (x, y) in enumerate(zip(la, lb)):
        if x != y:
            return i + 1
    return min(len(la), len(lb)) + 1


for anchor, srcfile in (("SECTION: recap card renderer", "recap-card.js"), ("SECTION: recap data builder", "recap-build.js")):
    block = pasted_block(app, anchor)
    path = os.path.join(ROOT, "design", "block-recap", srcfile)
    if block is None:
        bad("recap paste " + srcfile, "anchor or <script> block not found in app.html")
        continue
    if not os.path.isfile(path):
        bad("recap paste " + srcfile, "source file missing: " + path)
        continue
    src = read(path).rstrip("\n")
    if block.rstrip("\n") == src:
        ok("recap paste " + srcfile, "verbatim")
    else:
        bad("recap paste " + srcfile, "app.html copy differs from design/block-recap/%s (first difference at line %d of the pasted block) — fix in design/, re-paste" % (srcfile, first_diff(block.rstrip("\n"), src)))

# 6) iron rules 1 + 4 in boot.js --------------------------------------------------------
code_lines = []
for line in boot.split("\n"):
    st = line.strip()
    if st.startswith("//") or st.startswith("*") or st.startswith("/*"):
        continue
    code_lines.append(re.sub(r"(?<!:)//.*$", "", line))
code = "\n".join(code_lines)
viol = []
for m in re.finditer(r"\.upsert\(", code):
    stmt = code[m.start():code.find(";", m.start()) if code.find(";", m.start()) > 0 else m.start() + 400]
    if ".select(" in stmt:
        viol.append(code[max(0, m.start() - 60):m.start() + 80].replace("\n", " ").strip())
if viol:
    bad("iron rule 1 (no .select() on upsert)", " | ".join(viol)[:300])
else:
    ok("iron rule 1 (no .select() on upsert)", "%d upsert sites, none chained with .select()" % len(re.findall(r"\.upsert\(", code)))
if re.search(r"localStorage\.setItem\s*=[^=]", code):
    bad("iron rule 4 (no localStorage.setItem = …)", "assignment on the instance found — wrap Storage.prototype.setItem instead")
else:
    ok("iron rule 4 (no localStorage.setItem = …)", "interceptor lives on Storage.prototype")

# 7) no CDN scripts in the pages ----------------------------------------------------------
cdn = []
for name in sorted(os.listdir(os.path.join(ROOT, "public"))):
    if not name.endswith(".html"):
        continue
    html = read(os.path.join(ROOT, "public", name))
    for m in re.finditer(r'<script[^>]+src="(https?://[^"]+)"', html):
        cdn.append(name + " -> " + m.group(1))
if cdn:
    bad("no CDN scripts", "; ".join(cdn))
else:
    ok("no CDN scripts", "every <script src> is local")
lib = os.path.join(ROOT, "public", "assets", "js", "supabase.js")
if os.path.isfile(lib):
    head = read(lib)[:400]
    mv = re.search(r"supabase-js (\d+\.\d+\.\d+)", head)
    ok("supabase-js pinned", mv.group(1) if mv else "header has no version (see release.md §6)")
else:
    bad("supabase-js pinned", "public/assets/js/supabase.js missing")

# ---- report ------------------------------------------------------------------------------
fails = 0
for good, name, detail in results:
    print(("✅ " if good else "❌ ") + name + (" — " + detail if detail else ""))
    if not good:
        fails += 1
print("\n%s" % ("ALL GREEN — safe to commit" if not fails else "%d CHECK(S) FAILED — fix before committing" % fails))
sys.exit(1 if fails else 0)
