#!/usr/bin/env python3
"""
domain-agent — privileged host helper for the SMS gateway "Domains" panel.

Runs on the HOST (systemd), not in a container, because nginx + certbot live on
the host. The (unprivileged) api container talks to it over a token-authed unix
socket, exactly like the firewall-agent. It is the only thing allowed to:

  * issue/renew a Let's Encrypt cert for a domain  (certbot --webroot)
  * write an nginx server block for that domain     (sites-available + symlink)
  * validate + reload nginx                         (nginx -t ; systemctl reload)

Hard safety rules:
  * It ONLY ever touches files named "<MANAGED_PREFIX><domain>". The hand-written
    smsgw vhost (panel/API/SMPP edge) is never read for writing nor modified.
  * Every change runs `nginx -t` FIRST; on failure the just-written managed file
    is removed and nginx is NOT reloaded, so a bad entry can't take the edge down.
  * It refuses a domain whose server_name already appears in a non-managed vhost.

Stdlib only (Python 3.8+). JSON over HTTP on an AF_UNIX stream socket.
"""
from __future__ import annotations

import json
import os
import re
import socket as _socket
import subprocess
import sys
import threading
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler
from socketserver import ThreadingMixIn, UnixStreamServer

# ---- config (env) ----------------------------------------------------------
SOCKET_PATH = os.environ.get("DOMAIN_AGENT_SOCKET", "/run/domainagent/agent.sock")
TOKEN = os.environ.get("DOMAIN_AGENT_TOKEN", "")
STATE_FILE = os.environ.get("DOMAIN_AGENT_STATE", "/var/lib/domain-agent/state.json")
SITES_AVAILABLE = os.environ.get("NGINX_SITES_AVAILABLE", "/etc/nginx/sites-available")
SITES_ENABLED = os.environ.get("NGINX_SITES_ENABLED", "/etc/nginx/sites-enabled")
WEBROOT = os.environ.get("CERTBOT_WEBROOT", "/var/www/certbot")
LE_LIVE = os.environ.get("LETSENCRYPT_LIVE", "/etc/letsencrypt/live")
MANAGED_PREFIX = os.environ.get("DOMAIN_AGENT_PREFIX", "smsgw-managed-")
WEB_UPSTREAM = os.environ.get("DOMAIN_AGENT_WEB_UPSTREAM", "smsgw_web")
API_UPSTREAM = os.environ.get("DOMAIN_AGENT_API_UPSTREAM", "smsgw_api")
CERTBOT_EMAIL = os.environ.get("CERTBOT_EMAIL", "")  # optional; else --register-unsafely-without-email
CERTBOT_EXTRA = os.environ.get("CERTBOT_EXTRA_ARGS", "")  # e.g. "--staging" for testing

ROLES = ("panel", "smpp", "both")
# One DNS hostname. Lowercase labels, 1-63 chars each, total <=253, >=2 labels, alpha TLD.
DOMAIN_RE = re.compile(
    r"^(?=.{1,253}$)(?!-)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
    r"(?:\.(?!-)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$"
)
TLD_RE = re.compile(r"\.[a-z]{2,}$")

_lock = threading.Lock()


# ---- small helpers ---------------------------------------------------------
def _run(args, **kw):
    """Run a command, capturing output. Returns (rc, stdout+stderr)."""
    try:
        p = subprocess.run(
            args, stdin=kw.get("stdin"), capture_output=True, text=True,
            timeout=kw.get("timeout", 120),
        )
        return p.returncode, (p.stdout or "") + (p.stderr or "")
    except subprocess.TimeoutExpired:
        return 124, f"timed out: {' '.join(args)}"
    except FileNotFoundError:
        return 127, f"not found: {args[0]}"


def _now_iso():
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def managed_path(domain):
    return os.path.join(SITES_AVAILABLE, MANAGED_PREFIX + domain)


def enabled_path(domain):
    return os.path.join(SITES_ENABLED, MANAGED_PREFIX + domain)


def cert_paths(domain):
    base = os.path.join(LE_LIVE, domain)
    return os.path.join(base, "fullchain.pem"), os.path.join(base, "privkey.pem")


def cert_info(domain):
    full, _ = cert_paths(domain)
    if not os.path.exists(full):
        return {"exists": False, "expires": None}
    rc, out = _run(["openssl", "x509", "-enddate", "-noout", "-in", full], timeout=10)
    expires = None
    if rc == 0 and "notAfter=" in out:
        raw = out.split("notAfter=", 1)[1].strip()
        try:
            expires = datetime.strptime(raw, "%b %d %H:%M:%S %Y %Z").replace(
                tzinfo=timezone.utc).isoformat()
        except ValueError:
            expires = raw
    return {"exists": True, "expires": expires}


# ---- state (convenience; filesystem is the source of truth) ----------------
def load_state():
    try:
        with open(STATE_FILE) as fh:
            d = json.load(fh)
            return d if isinstance(d, dict) else {}
    except (FileNotFoundError, ValueError):
        return {}


def save_state(state):
    os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
    tmp = STATE_FILE + ".tmp"
    with open(tmp, "w") as fh:
        json.dump(state, fh, indent=2, sort_keys=True)
    os.replace(tmp, STATE_FILE)


# ---- nginx vhost rendering -------------------------------------------------
_SSL_COMMON = """    ssl_certificate     {full};
    ssl_certificate_key {key};
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
"""


def render_vhost(domain, role):
    full, key = cert_paths(domain)
    ssl = _SSL_COMMON.format(full=full, key=key)
    header = (
        f"# MANAGED BY domain-agent — do not edit by hand.\n"
        f"# domain={domain} role={role} generated={_now_iso()}\n"
    )
    if role == "smpp":
        # SMPP is raw TCP straight from the engine (nginx not involved). This block
        # only presents a valid cert on :443 and serves no panel.
        return header + f"""server {{
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name {domain};
    server_tokens off;
{ssl}
    location / {{ return 404; }}
}}
"""
    # role panel or both -> full panel + API proxy (mirrors the hand-written edge;
    # reuses the shared upstreams and rate-limit zones defined in the smsgw vhost).
    return header + f"""server {{
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name {domain};
    server_tokens off;
    client_max_body_size 26m;
{ssl}
    add_header Content-Security-Policy "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; font-src 'self' data:; connect-src 'self'; form-action 'self'" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "DENY" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    add_header Permissions-Policy "geolocation=(), microphone=(), camera=()" always;

    proxy_http_version 1.1;
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Connection        "";
    proxy_connect_timeout 5s;
    proxy_read_timeout    120s;

    location = /api/auth/login {{
        limit_req zone=smsgw_auth burst=20 nodelay;
        proxy_pass http://{API_UPSTREAM};
    }}
    location /api/messages/export {{
        proxy_buffering off;
        proxy_read_timeout 900s;
        proxy_pass http://{API_UPSTREAM};
    }}
    location /api/docs {{ return 404; }}
    location /api/ {{ proxy_pass http://{API_UPSTREAM}; }}
    location /v1/ {{
        limit_req zone=smsgw_public_api burst=400 nodelay;
        proxy_pass http://{API_UPSTREAM};
    }}
    location /_next/static/ {{
        proxy_pass http://{WEB_UPSTREAM};
        expires 365d;
        add_header Cache-Control "public, immutable";
    }}
    location / {{ proxy_pass http://{WEB_UPSTREAM}; }}
}}
"""


# ---- conflict / discovery --------------------------------------------------
def server_name_conflict(domain):
    """True if `domain` is already a server_name in a NON-managed enabled vhost."""
    try:
        names = os.listdir(SITES_ENABLED)
    except FileNotFoundError:
        return False
    pat = re.compile(r"^\s*server_name\s+([^;]+);", re.MULTILINE)
    mine = MANAGED_PREFIX + domain
    for name in names:
        if name == mine:
            continue
        path = os.path.join(SITES_ENABLED, name)
        try:
            with open(path) as fh:
                text = fh.read()
        except (OSError, UnicodeDecodeError):
            continue
        for m in pat.finditer(text):
            if domain in m.group(1).split():
                return True
    return False


def list_managed():
    out = []
    state = load_state()
    try:
        files = sorted(os.listdir(SITES_AVAILABLE))
    except FileNotFoundError:
        files = []
    for name in files:
        if not name.startswith(MANAGED_PREFIX):
            continue
        domain = name[len(MANAGED_PREFIX):]
        role = "panel"
        try:
            with open(os.path.join(SITES_AVAILABLE, name)) as fh:
                head = fh.read(400)
            m = re.search(r"role=(\w+)", head)
            if m:
                role = m.group(1)
        except OSError:
            pass
        out.append({
            "domain": domain,
            "role": role,
            "enabled": os.path.islink(enabled_path(domain)) or os.path.exists(enabled_path(domain)),
            "cert": cert_info(domain),
            "added_at": state.get(domain, {}).get("added_at"),
        })
    return out


# ---- validation ------------------------------------------------------------
class BadRequest(Exception):
    pass


def validate_add(body):
    if not isinstance(body, dict):
        raise BadRequest("body must be an object")
    domain = str(body.get("domain", "")).strip().lower().rstrip(".")
    role = str(body.get("role", "")).strip().lower()
    if not domain or not DOMAIN_RE.match(domain) or not TLD_RE.search(domain):
        raise BadRequest("invalid domain")
    if len(domain) > 253:
        raise BadRequest("domain too long")
    if role not in ROLES:
        raise BadRequest("role must be one of: " + ", ".join(ROLES))
    return domain, role


# ---- operations ------------------------------------------------------------
def nginx_test():
    return _run(["nginx", "-t"], timeout=30)


def nginx_reload():
    return _run(["systemctl", "reload", "nginx"], timeout=30)


def issue_cert(domain):
    args = [
        "certbot", "certonly", "--webroot", "-w", WEBROOT,
        "-d", domain, "--cert-name", domain,
        "--non-interactive", "--agree-tos", "--keep-until-expiring",
    ]
    if CERTBOT_EMAIL:
        args += ["--email", CERTBOT_EMAIL]
    else:
        args += ["--register-unsafely-without-email"]
    if CERTBOT_EXTRA:
        args += CERTBOT_EXTRA.split()
    return _run(args, timeout=180)


def op_add(body):
    domain, role = validate_add(body)
    with _lock:
        if server_name_conflict(domain):
            raise BadRequest(f"{domain} is already served by another (non-managed) vhost")

        # 1. ensure a cert exists (idempotent; webroot ACME is served by the edge on :80).
        full, _ = cert_paths(domain)
        if not os.path.exists(full):
            rc, out = issue_cert(domain)
            if rc != 0 or not os.path.exists(full):
                raise BadRequest("certbot failed — check that the domain's DNS points "
                                 "to this host.\n" + out[-1500:])

        # 2. write the managed vhost + enable it (keep a backup of any prior managed file).
        path, link = managed_path(domain), enabled_path(domain)
        prev = None
        if os.path.exists(path):
            with open(path) as fh:
                prev = fh.read()
        with open(path, "w") as fh:
            fh.write(render_vhost(domain, role))
        if not (os.path.islink(link) or os.path.exists(link)):
            os.symlink(path, link)

        # 3. validate BEFORE reloading; roll back the managed file on failure.
        rc, out = nginx_test()
        if rc != 0:
            if prev is not None:
                with open(path, "w") as fh:
                    fh.write(prev)
            else:
                _safe_unlink(link)
                _safe_unlink(path)
            raise BadRequest("nginx config test failed; change rolled back.\n" + out[-1500:])

        rc, rout = nginx_reload()
        if rc != 0:
            raise RuntimeError("nginx reloaded failed: " + rout[-800:])

        state = load_state()
        state[domain] = {"role": role, "added_at": state.get(domain, {}).get("added_at") or _now_iso(),
                         "updated_at": _now_iso()}
        save_state(state)
    return {"ok": True, "domain": domain, "role": role}


def op_remove(body):
    if not isinstance(body, dict):
        raise BadRequest("body must be an object")
    domain = str(body.get("domain", "")).strip().lower().rstrip(".")
    if not DOMAIN_RE.match(domain):
        raise BadRequest("invalid domain")
    with _lock:
        path, link = managed_path(domain), enabled_path(domain)
        if not os.path.exists(path) and not os.path.islink(link):
            raise BadRequest("not a managed domain")
        _safe_unlink(link)
        _safe_unlink(path)
        rc, out = nginx_test()
        if rc != 0:
            raise RuntimeError("nginx config test failed after removal.\n" + out[-1200:])
        nginx_reload()
        state = load_state()
        state.pop(domain, None)
        save_state(state)
    # certs are left on disk (harmless; certbot keeps renewing until deleted).
    return {"ok": True, "domain": domain}


def _safe_unlink(p):
    try:
        os.unlink(p)
    except FileNotFoundError:
        pass


def op_status():
    rc, _ = nginx_test()
    return {"available": True, "nginx_ok": rc == 0, "domains": list_managed()}


# ---- HTTP over unix socket -------------------------------------------------
class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):  # quiet; systemd journal captures stderr prints
        pass

    def _auth_ok(self):
        return bool(TOKEN) and self.headers.get("X-Domain-Token", "") == TOKEN

    def _send(self, code, obj):
        payload = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _body(self):
        length = int(self.headers.get("Content-Length", 0) or 0)
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw or b"{}")
        except ValueError:
            raise BadRequest("invalid JSON body")

    def do_GET(self):
        if not self._auth_ok():
            return self._send(401, {"error": "unauthorized"})
        if self.path == "/status":
            return self._send(200, op_status())
        return self._send(404, {"error": "not found"})

    def do_POST(self):
        if not self._auth_ok():
            return self._send(401, {"error": "unauthorized"})
        try:
            body = self._body()
            if self.path == "/add":
                return self._send(200, op_add(body))
            if self.path == "/remove":
                return self._send(200, op_remove(body))
            return self._send(404, {"error": "not found"})
        except BadRequest as e:
            return self._send(400, {"error": str(e)})
        except Exception as e:  # noqa: BLE001 — surface as 500, keep agent alive
            sys.stderr.write(f"domain-agent error: {e}\n")
            sys.stderr.flush()
            return self._send(500, {"error": str(e)})


class Server(ThreadingMixIn, UnixStreamServer):
    daemon_threads = True
    allow_reuse_address = True


def main():
    if not TOKEN:
        raise SystemExit("DOMAIN_AGENT_TOKEN is required")
    os.makedirs(os.path.dirname(SOCKET_PATH), exist_ok=True)
    try:
        os.unlink(SOCKET_PATH)
    except FileNotFoundError:
        pass
    server = Server(SOCKET_PATH, Handler)
    os.chmod(SOCKET_PATH, 0o666)  # security is the token, not socket perms
    sys.stderr.write(f"domain-agent listening on {SOCKET_PATH}\n")
    sys.stderr.flush()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        _safe_unlink(SOCKET_PATH)


if __name__ == "__main__":
    main()
