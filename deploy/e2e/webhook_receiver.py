#!/usr/bin/env python3
"""Webhook receiver for deploy/e2e.sh.

Appends every POST it receives as one JSON line to --out:
  {"path": "...", "headers": {lower-case name: value}, "body": "<raw body as text>", "received_at": <unix>}
GET /health answers 200; GET /events returns the recorded lines as a JSON array.
Signature checking is done by e2e.sh (it knows the secret), so this stays a dumb logger.
"""
import argparse
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LOCK = threading.Lock()


def make_handler(out_path):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):  # quiet access log
            pass

        def _send(self, code, body, ctype="application/json"):
            data = body.encode()
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            if self.path == "/health":
                return self._send(200, '{"ok":true}')
            if self.path == "/events":
                with LOCK:
                    try:
                        with open(out_path, encoding="utf-8") as f:
                            rows = [json.loads(l) for l in f if l.strip()]
                    except FileNotFoundError:
                        rows = []
                return self._send(200, json.dumps(rows))
            return self._send(404, '{"error":"not found"}')

        def do_POST(self):
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length) if length > 0 else b""
            rec = {
                "path": self.path,
                "headers": {k.lower(): v for k, v in self.headers.items()},
                "body": raw.decode("utf-8", errors="replace"),
                "received_at": time.time(),
            }
            with LOCK:
                with open(out_path, "a", encoding="utf-8") as f:
                    f.write(json.dumps(rec) + "\n")
            return self._send(200, '{"received":true}')

    return Handler


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=2899)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    open(a.out, "w").close()
    srv = ThreadingHTTPServer((a.host, a.port), make_handler(a.out))
    srv.serve_forever()


if __name__ == "__main__":
    main()
