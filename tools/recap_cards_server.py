# -*- coding: utf-8 -*-
"""
Recap-card factory — CrossFit Bat Yam · Capacity Tracker
=========================================================
Renders the block-recap share card (the SAME renderer the app ships,
design/block-recap/recap-card.js + recap-build.js) for EVERY member in an
admin backup file, and saves the PNGs next to the member's summary:

    <out>/participants/<name>/recap-story.png   1440 × 2560
    <out>/participants/<name>/recap-feed.png    1440 × 1800

Why a server: html2canvas + web fonts need a real browser, and the browser
must be able to hand the PNG back to disk without a download prompt per file
— so this serves the harness page and receives the PNGs over POST.

Usage (defaults pick the newest backup in Ori's backup folder and the
block-summary folder tools/block_summary.py writes for it):
    python tools/recap_cards_server.py [backup.json] [out_dir] [port]
then open  http://localhost:8171/  and press "הפק את כל הכרטיסים"
(or open  http://localhost:8171/?auto=1  to run on load).
Also serves the summary folder at  http://localhost:8171/out/index.html
"""
import glob
import json
import os
import re
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse

try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))     # repo root
BACKUP_DIR = r"C:\Users\leaan\Desktop\crossfit manager project\CFBY Capacity Dashboard"   # where Chrome drops 💾 files


def newest_backup():
    files = sorted(glob.glob(os.path.join(BACKUP_DIR, 'batyam-backup-*.json')), key=os.path.getmtime)
    return files[-1] if files else None


def default_out(backup_path):
    try:
        created = json.load(open(backup_path, encoding='utf-8')).get('created_at', '')[:10]
    except Exception:
        created = ''
    return os.path.join(os.path.dirname(backup_path), 'block1-summary-' + (created or 'latest'))


BACKUP = sys.argv[1] if len(sys.argv) > 1 and sys.argv[1].endswith('.json') else newest_backup()
if not BACKUP or not os.path.exists(BACKUP):
    sys.exit('no backup file found — pass one: python tools/recap_cards_server.py <backup.json> <out_dir>')
OUT = sys.argv[2] if len(sys.argv) > 2 else default_out(BACKUP)
PORT = int(sys.argv[3]) if len(sys.argv) > 3 else 8171

# url path → file on disk (the harness never touches the network for code)
LIB = {
    '/lib/react.js': os.path.join(ROOT, 'public', 'assets', 'js', 'react.js'),
    '/lib/react-dom.js': os.path.join(ROOT, 'public', 'assets', 'js', 'react-dom.js'),
    '/lib/html2canvas.js': os.path.join(ROOT, 'public', 'assets', 'js', 'html2canvas.js'),
    '/lib/recap-build.js': os.path.join(ROOT, 'design', 'block-recap', 'recap-build.js'),
    '/lib/recap-card.js': os.path.join(ROOT, 'design', 'block-recap', 'recap-card.js'),
    '/assets/logo.png': os.path.join(ROOT, 'public', 'assets', 'logo.png'),
    '/backup.json': BACKUP,
    '/': os.path.join(ROOT, 'tools', 'recap-harness.html'),
    '/index.html': os.path.join(ROOT, 'tools', 'recap-harness.html'),
}


def safe_folder(name):          # must match tools/block_summary.py
    s = re.sub(r'[\\/:*?"<>|]+', ' ', name).strip()
    return s or 'unknown'


class H(SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=os.path.join(ROOT, 'tools'), **k)

    def translate_path(self, path):
        p = unquote(path.split('?', 1)[0])
        if p in LIB:
            return LIB[p]
        if p.startswith('/out/'):
            return os.path.normpath(os.path.join(OUT, p[5:].replace('/', os.sep)))
        return os.path.join(ROOT, 'tools', '__nope__')      # nothing else is served

    def do_POST(self):
        u = urlparse(self.path)
        if u.path != '/save':
            self.send_error(404); return
        q = parse_qs(u.query)
        user = (q.get('user') or [''])[0]
        fmt = (q.get('fmt') or ['story'])[0]
        if fmt not in ('story', 'feed') or not user:
            self.send_error(400, 'bad params'); return
        data = self.rfile.read(int(self.headers.get('Content-Length') or 0))
        if data[:8] != b'\x89PNG\r\n\x1a\n':
            self.send_error(400, 'not a png'); return
        d = os.path.join(OUT, 'participants', safe_folder(user))
        os.makedirs(d, exist_ok=True)
        p = os.path.join(d, 'recap-%s.png' % fmt)
        with open(p, 'wb') as f:
            f.write(data)
        body = json.dumps({'saved': p, 'bytes': len(data)}, ensure_ascii=False).encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)
        print('[save]', p, len(data), 'bytes', flush=True)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def log_message(self, fmt, *args):
        if '/save' in (args[0] if args else '') or ' 4' in (args[1] if len(args) > 1 else ''):
            super().log_message(fmt, *args)


if __name__ == '__main__':
    print('recap cards: backup = %s' % BACKUP, flush=True)
    print('recap cards: out    = %s' % OUT, flush=True)
    print('recap cards: open http://localhost:%d/  (summaries at /out/index.html)' % PORT, flush=True)
    ThreadingHTTPServer(('127.0.0.1', PORT), H).serve_forever()
