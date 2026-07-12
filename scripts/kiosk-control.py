#!/usr/bin/env python3
"""
Minimal HTTP control server for the Pi kiosk.
Runs as a systemd service (user pi) on port 8080.
Serves a control page at / and accepts POST /restart to kill chromium+cage,
which the while-true loop in ~/.bash_profile then restarts automatically.
"""
import http.server
import subprocess

PAGE = b"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Kiosk Control</title>
<style>
  body { font-family: sans-serif; background: #0f2346; color: #fff;
         padding: 32px; max-width: 400px; margin: 0 auto; }
  h2   { margin-bottom: 24px; font-size: 1.4rem; }
  button { background: #d4af37; color: #0f2346; border: none;
           padding: 12px 28px; font-size: 1rem; font-weight: 700;
           border-radius: 6px; cursor: pointer; }
  button:active { opacity: .8; }
  p { margin-top: 16px; color: #b4c8e4; font-size: .9rem; min-height: 1.2em; }
</style>
</head>
<body>
<h2>Kiosk Control</h2>
<button onclick="restart()">Restart kiosk</button>
<p id="msg"></p>
<script>
function restart() {
  document.getElementById('msg').textContent = 'Restarting...';
  fetch('/restart', { method: 'POST' })
    .then(() => { document.getElementById('msg').textContent = 'Done - kiosk will be back in a few seconds.'; })
    .catch(() => { document.getElementById('msg').textContent = 'Request failed — check the Pi is reachable.'; });
}
</script>
</body>
</html>"""


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/':
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.end_headers()
            self.wfile.write(PAGE)
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        if self.path == '/restart':
            subprocess.Popen(['pkill', 'chromium'])
            subprocess.Popen(['pkill', 'cage'])
            self.send_response(200)
            self.send_header('Content-Type', 'text/plain')
            self.end_headers()
            self.wfile.write(b'ok')
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, *_):
        pass


if __name__ == '__main__':
    http.server.HTTPServer(('0.0.0.0', 8080), Handler).serve_forever()
