# -*- coding: utf-8 -*-
# Builds the self-contained Block Recap preview artifact.
#
# Everything is inlined: the Artifact CSP blocks external hosts (Google Fonts
# is the one exception), so React is replaced by a ~20-line DOM shim rather
# than bundled, and the logo rides in as the app's own 12KB webp data URI.
#
# The output is deliberately PURE ASCII - Hebrew leaves as &#N; in markup and
# as \uXXXX in script. A page that renders correctly whatever charset the host
# assumes is worth more than one that depends on the wrapper getting it right.
import io, re, os

D = os.path.dirname(os.path.abspath(__file__))          # design/block-recap
ROOT = os.path.dirname(os.path.dirname(D))              # repo root
OUT = os.path.join(D, "standalone.html")


def esc_js(t):
    """Non-ASCII -> \\uXXXX, astral chars as surrogate pairs (JS has no \\U)."""
    out = []
    for ch in t:
        o = ord(ch)
        if o < 128:
            out.append(ch)
        elif o <= 0xFFFF:
            out.append("\\u%04X" % o)
        else:
            o -= 0x10000
            out.append("\\u%04X\\u%04X" % (0xD800 + (o >> 10), 0xDC00 + (o & 0x3FF)))
    return "".join(out)


def esc_html(t):
    return "".join(ch if ord(ch) < 128 else "&#%d;" % ord(ch) for ch in t)


card = io.open(os.path.join(D, "recap-card.js"), encoding="utf-8").read()
demo = io.open(os.path.join(D, "recap-demo.js"), encoding="utf-8").read()
app = io.open(os.path.join(ROOT, "public", "app.html"), encoding="utf-8").read()
logo = re.search(r"data:image/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+", app).group(0)

# ---------------------------------------------------------------- markup ----
MARKUP = u"""<title>כרטיס סיכום בלוק</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Heebo:wght@400;500;600;700;800&family=IBM+Plex+Mono:wght@400;500&family=Oswald:wght@500;600;700&display=swap">

<style>
  /* Light is the base palette; the blocks below redefine only tokens, so the
     un-stamped "system" state resolves correctly in both directions. */
  :root {
    --ground:#E7E9EE; --surface:#FFFFFF; --ink:#161B29; --muted:#69738C;
    --line:#CFD5E0; --accent:#1F6E80; --accent-ink:#FFFFFF; --shadow:12,18,34;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --ground:#0E1118; --surface:#171B25; --ink:#E6E9F0; --muted:#8892A6;
      --line:#272D3A; --accent:#3FB8CF; --accent-ink:#0E1118; --shadow:0,0,0;
    }
  }
  :root[data-theme="dark"] {
    --ground:#0E1118; --surface:#171B25; --ink:#E6E9F0; --muted:#8892A6;
    --line:#272D3A; --accent:#3FB8CF; --accent-ink:#0E1118; --shadow:0,0,0;
  }

  * { box-sizing:border-box; }
  body {
    margin:0; background:var(--ground); color:var(--ink);
    font-family:'Heebo',system-ui,sans-serif; direction:rtl;
    overflow-x:hidden; -webkit-font-smoothing:antialiased;
  }
  .wrap { max-width:1160px; margin:0 auto; padding:0 20px 72px; }

  header { padding:34px 0 18px; }
  h1 { margin:0; font-size:clamp(25px,4.4vw,37px); font-weight:800; letter-spacing:-.02em; text-wrap:balance; }
  .lede { margin:8px 0 0; color:var(--muted); font-size:15.5px; line-height:1.62; max-width:60ch; }

  /* controls -------------------------------------------------------------- */
  .controls {
    position:sticky; top:0; z-index:5; background:var(--ground);
    border-bottom:1px solid var(--line); padding:12px 0 14px; margin-bottom:26px;
  }
  .ctl-row { display:flex; flex-wrap:wrap; align-items:center; gap:8px; }
  .ctl-row + .ctl-row { margin-top:9px; }
  .ctl-lbl {
    font-family:'IBM Plex Mono',ui-monospace,monospace;
    font-size:10.5px; color:var(--muted); letter-spacing:.09em;
    text-transform:uppercase; min-width:70px;
  }
  button {
    font-family:inherit; font-size:13px; font-weight:600; cursor:pointer;
    border:1px solid var(--line); background:var(--surface); color:var(--ink);
    border-radius:7px; padding:7px 12px; display:inline-flex; align-items:center; gap:7px;
    transition:border-color .12s, background .12s, color .12s;
  }
  button:hover { border-color:var(--accent); }
  button:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
  button[aria-pressed="true"] { background:var(--accent); border-color:var(--accent); color:var(--accent-ink); }
  .dot { width:12px; height:12px; border-radius:50%; flex:none; border:1px solid rgba(128,128,128,.45); }

  /* contact sheet --------------------------------------------------------- */
  .sheet { display:flex; flex-wrap:wrap; gap:34px; align-items:flex-start; justify-content:center; }
  .slot { flex:1 1 400px; min-width:0; max-width:560px; }
  .spec {
    display:flex; flex-wrap:wrap; align-items:baseline; gap:5px 12px;
    padding-bottom:9px; margin-bottom:11px; border-bottom:1px solid var(--line);
  }
  .spec b { font-size:14px; font-weight:700; }
  .spec span {
    font-family:'IBM Plex Mono',ui-monospace,monospace; font-size:11px;
    color:var(--muted); font-variant-numeric:tabular-nums;
  }
  .spec .ratio { color:var(--accent); }
  /* ltr on the frame only - the card carries its own dir="rtl" - so the scale
     origin stays predictable regardless of page direction. */
  .frame { direction:ltr; overflow:hidden; border-radius:10px; box-shadow:0 14px 44px rgba(var(--shadow),.22); max-width:100%; }
  .scaler { width:1080px; transform-origin:top left; }

  /* legend ---------------------------------------------------------------- */
  .legend { margin-top:52px; padding-top:26px; border-top:1px solid var(--line); }
  .legend h2 { margin:0 0 4px; font-size:19px; font-weight:700; }
  .legend > p { margin:0 0 18px; color:var(--muted); font-size:14.5px; line-height:1.6; max-width:60ch; }
  .keys { display:grid; grid-template-columns:repeat(auto-fit,minmax(212px,1fr)); gap:11px; }
  .key {
    background:var(--surface); border:1px solid var(--line); border-radius:9px;
    padding:12px 14px; display:flex; gap:11px; align-items:flex-start;
  }
  .chip { width:15px; height:15px; border-radius:4px; flex:none; margin-top:3px; border:1px solid rgba(128,128,128,.45); }
  .key b { display:block; font-size:14px; font-weight:700; }
  .key small { display:block; color:var(--muted); font-size:12.5px; line-height:1.5; margin-top:2px; }
  .key code { display:block; font-family:'IBM Plex Mono',ui-monospace,monospace; font-size:10.5px; color:var(--muted); margin-top:4px; }

  .note { margin-top:24px; color:var(--muted); font-size:13.5px; line-height:1.68; max-width:66ch; }
  .note strong { color:var(--ink); font-weight:600; }

  @media (prefers-reduced-motion:reduce) { * { transition:none !important; } }
</style>

<div class="wrap">
  <header>
    <h1>כרטיס סיכום בלוק — התבנית</h1>
    <p class="lede">
      שני הפורמטים, חיים. החלף ערכת נתונים או צבע מבטא והכרטיסים מתעדכנים מיד.
      לא חובר לאפליקציה ולא נדחף לפרודקשן.
    </p>
  </header>

  <div class="controls">
    <div class="ctl-row" id="sets" role="group" aria-label="ערכת נתונים">
      <span class="ctl-lbl">נתונים</span>
    </div>
    <div class="ctl-row" id="accents" role="group" aria-label="צבע מבטא">
      <span class="ctl-lbl">מבטא</span>
    </div>
  </div>

  <div class="sheet">
    <div class="slot">
      <div class="spec"><b>סטורי</b><span class="ratio" id="ratio-story"></span><span id="spec-story"></span></div>
      <div class="frame" id="frame-story"><div class="scaler" id="scaler-story"></div></div>
    </div>
    <div class="slot">
      <div class="spec"><b>פיד</b><span class="ratio" id="ratio-feed"></span><span id="spec-feed"></span></div>
      <div class="frame" id="frame-feed"><div class="scaler" id="scaler-feed"></div></div>
    </div>
  </div>

  <section class="legend">
    <h2>מערכת הצבע — תפקיד אחד לכל צבע</h2>
    <p>כל צבע בכרטיס עושה דבר אחד בלבד. זו הסיבה שאפשר לקרוא אותו בלי מקרא.</p>
    <div class="keys">
      <div class="key">
        <span class="chip" style="background:linear-gradient(90deg,#E5564C,#E8A53A 50%,#3FBF6A)"></span>
        <div><b>רמפה אדום→ירוק</b><small>מדידות: נוכחות, מבחנים, Hero. ככל שטוב יותר — ירוק יותר.</small><code>#E5564C · #E8A53A · #3FBF6A</code></div>
      </div>
      <div class="key">
        <span class="chip" style="background:#F0C064"></span>
        <div><b>זהב</b><small>הישגים בלבד — הבאדג׳ים וערכי השיאים.</small><code>#F0C064</code></div>
      </div>
      <div class="key">
        <span class="chip" id="chip-accent"></span>
        <div><b id="name-accent"></b><small>תוויות סקשן ושורת הפוטר. שום דבר שהוא נוגע בו לא מחזיק ערך.</small><code id="code-accent"></code></div>
      </div>
      <div class="key">
        <span class="chip" style="background:#FFFFFF"></span>
        <div><b>לבן</b><small>תוכן — שמות תרגילים וערכים. הגודל והמשקל מפרידים בין תווית לתוכן.</small><code>#FFFFFF</code></div>
      </div>
      <div class="key">
        <span class="chip" style="background:#8FA4D8"></span>
        <div><b>עמום</b><small>פירוט תומך וכיתובים.</small><code>#8FA4D8</code></div>
      </div>
    </div>

    <p class="note">
      <strong>למה שניהם ברוחב 1080.</strong>
      זה רוחב הקנבס של אינסטגרם לכל פורמט; מה שמבדיל הוא הגובה והיחס.
      הייצוא עולה ל-1440 רוחב (scale של 4/3) לפי המלצת מטא ל-2026 למסכים בצפיפות גבוהה,
      בלי שהפריסה זזה. <strong>הורדת PNG לא עובדת בעמוד הזה</strong> — לזה יש את התצוגה המקומית ברֵפּו.
    </p>
  </section>
</div>
"""

# ------------------------------------------------------------- page script ----
PAGE_JS = u"""
(function () {
  'use strict';
  var LOGO = '__LOGO__';
  var SETS = [
    { k:'batyam',    label:'הבלוק האמיתי · 4 מבחנים' },
    { k:'reference', label:'רפרנס העיצוב · 3 מבחנים' },
    { k:'edge',      label:'מצב שקט · בלי רי-טסט ובלי שיאים' }
  ];
  var setKey = 'batyam';

  Object.keys(BlockRecapDemo).forEach(function (k) { BlockRecapDemo[k].logo = LOGO; });

  function mkBtn(row, label, pressed, onClick, swatch) {
    var b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('aria-pressed', pressed ? 'true' : 'false');
    if (swatch) {
      var d = document.createElement('span');
      d.className = 'dot'; d.style.background = swatch;
      b.appendChild(d);
    }
    b.appendChild(document.createTextNode(label));
    b.addEventListener('click', onClick);
    row.appendChild(b);
    return b;
  }

  function buildControls() {
    var setRow = document.getElementById('sets'), accRow = document.getElementById('accents');
    SETS.forEach(function (s) {
      mkBtn(setRow, s.label, s.k === setKey, function () { setKey = s.k; refresh(); });
    });
    Object.keys(BlockRecapCard.accents).forEach(function (k) {
      var a = BlockRecapCard.accents[k];
      mkBtn(accRow, a.label, k === BlockRecapCard.tokens.accentName,
        function () { BlockRecapCard.setAccent(k); refresh(); },
        'rgb(' + a.rgb.join(',') + ')');
    });
  }

  function syncPressed() {
    var setBtns = document.querySelectorAll('#sets button');
    SETS.forEach(function (s, i) { setBtns[i].setAttribute('aria-pressed', s.k === setKey ? 'true' : 'false'); });
    var accBtns = document.querySelectorAll('#accents button');
    Object.keys(BlockRecapCard.accents).forEach(function (k, i) {
      accBtns[i].setAttribute('aria-pressed', k === BlockRecapCard.tokens.accentName ? 'true' : 'false');
    });
    var accent = BlockRecapCard.tokens.accent;
    document.getElementById('chip-accent').style.background = accent;
    document.getElementById('code-accent').textContent = accent;
    document.getElementById('name-accent').textContent =
      'מבטא · ' + BlockRecapCard.accents[BlockRecapCard.tokens.accentName].label;
  }

  /* Scale each card to whatever width the column actually got. Guarded two
     ways: a zero measurement (pane not laid out yet, tab still hidden) keeps
     the last good size instead of collapsing the frame to nothing, and an
     unchanged scale is a no-op so the ResizeObserver below cannot feed itself. */
  var lastScale = {};
  function fit(f) {
    var S = BlockRecapCard.sizes[f];
    var frame = document.getElementById('frame-' + f);
    var avail = frame.parentElement.clientWidth;
    if (!avail) return;
    var scale = Math.min(1, avail / S.w);
    if (lastScale[f] === scale) return;
    lastScale[f] = scale;
    document.getElementById('scaler-' + f).style.transform = 'scale(' + scale + ')';
    frame.style.width  = Math.round(S.w * scale) + 'px';
    frame.style.height = Math.round(S.hgt * scale) + 'px';
  }

  function refresh() {
    var d = BlockRecapDemo[setKey];
    ['story', 'feed'].forEach(function (f) {
      var S = BlockRecapCard.sizes[f];
      var host = document.getElementById('scaler-' + f);
      host.textContent = '';
      host.appendChild(BlockRecapCard.el(d, f));
      document.getElementById('ratio-' + f).textContent = S.ratio;
      document.getElementById('spec-' + f).textContent =
        'פריסה ' + S.w + '×' + S.hgt + '  →  ייצוא ' + S.exp.w + '×' + S.exp.h;
      fit(f);
    });
    syncPressed();
  }

  function fitAll() { ['story', 'feed'].forEach(fit); }
  function slotWidth() { return document.getElementById('frame-story').parentElement.clientWidth; }

  buildControls();
  refresh();

  /* Three ways in, because no single one is reliable everywhere:
       - window.resize covers the ordinary case;
       - ResizeObserver covers a column that changes width while the window
         does not (it is a no-op in hosts that never fire it);
       - and a bounded poll covers the first paint landing at zero width -
         a hidden or not-yet-laid-out pane - which would otherwise leave the
         cards unscaled forever, since nothing later would fire an event. */
  addEventListener('resize', fitAll);
  if (window.ResizeObserver) {
    var ro = new ResizeObserver(fitAll);
    ['story', 'feed'].forEach(function (f) {
      ro.observe(document.getElementById('frame-' + f).parentElement);
    });
  }
  if (!slotWidth()) {
    var poll = setInterval(function () { if (slotWidth()) { fitAll(); clearInterval(poll); } }, 150);
    setTimeout(function () { clearInterval(poll); }, 20000);
  }
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(refresh);
})();
"""

SHIM_JS = u"""
/* A ~20-line stand-in for React.createElement. The renderer only ever asks for
   a tag, an inline style object, a few attributes and nested children, so there
   is no reason to ship a framework inside the artifact. */
window.React = { createElement: function (tag, props) {
  var el = document.createElement(tag), i;
  if (props) Object.keys(props).forEach(function (k) {
    if (k === 'key' || props[k] == null) return;
    if (k === 'style') Object.assign(el.style, props[k]);
    else el.setAttribute(k, props[k]);
  });
  function add(c) {
    if (c == null || c === false) return;
    if (Array.isArray(c)) { c.forEach(add); return; }
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  for (i = 2; i < arguments.length; i++) add(arguments[i]);
  return el;
} };
"""

page_js = PAGE_JS.replace(u"__LOGO__", logo)

html = (
    esc_html(MARKUP)
    + u"\n<script>\n" + esc_js(SHIM_JS) + u"\n</script>\n"
    + u"\n<script>\n" + esc_js(card) + u"\n</script>\n"
    + u"\n<script>\n" + esc_js(demo) + u"\n</script>\n"
    + u"\n<script>\n" + esc_js(page_js) + u"\n</script>\n"
)

assert all(ord(c) < 128 for c in html), "output is not pure ASCII"
assert "</script" not in card and "</script" not in demo

io.open(OUT, "w", encoding="ascii").write(html)
print("wrote", OUT)
print("size:", round(os.path.getsize(OUT) / 1024.0, 1), "KB  (pure ASCII)")
