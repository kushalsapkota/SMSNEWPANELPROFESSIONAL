#!/usr/bin/env python3
"""
SMS gateway host firewall agent.

Runs in a dedicated container with the HOST network namespace + CAP_NET_ADMIN, so the nftables
rules it installs apply to the host. The API (unprivileged) drives it over a Unix socket on a
shared volume, authenticated with a shared token. The agent owns ONE nftables table, `inet smsgw`,
and never touches any other table, so it can't clobber Docker's own rules.

Safety model (so a bad ruleset can't lock anyone out of a live box):
  * Ports 22 (SSH), 80/443 (panel) and the SMPP ports are ALWAYS accepted, as are loopback,
    established/related connections and ICMP. These are not expressible as removable rules.
  * Every apply is staged: the previous ruleset is restored automatically after
    FW_REVERT_SECONDS unless the caller commits. A caller that locked itself out simply waits.
  * `enabled=false` deletes the table entirely (no enforcement). This is the default, so merely
    deploying the agent changes nothing until an admin turns it on and commits.
  * On startup the agent reapplies the last committed state from FW_STATE_FILE (reboot-safe).
"""
import json
import os
import re
import socket
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler
from socketserver import ThreadingMixIn, UnixStreamServer

SOCKET_PATH = os.environ.get("FW_AGENT_SOCKET", "/run/fwagent/agent.sock")
STATE_FILE = os.environ.get("FW_STATE_FILE", "/var/lib/fwagent/state.json")
TOKEN = os.environ.get("FW_AGENT_TOKEN", "")
REVERT_SECONDS = int(os.environ.get("FW_REVERT_SECONDS", "60"))
TABLE = "smsgw"
# Ports that must never become unreachable, whatever the admin configures.
PROTECTED_TCP = [22, 80, 443]
for _p in (os.environ.get("FW_PROTECTED_PORTS", "2775,3775")).split(","):
    _p = _p.strip()
    if _p.isdigit():
        PROTECTED_TCP.append(int(_p))
PROTECTED_TCP = sorted(set(PROTECTED_TCP))

_lock = threading.RLock()
_pending_timer = None  # type: threading.Timer | None
_pending_deadline = 0.0

CIDR_RE = re.compile(r"^\d{1,3}(\.\d{1,3}){3}(/\d{1,2})?$|^[0-9a-fA-F:]+(/\d{1,3})?$")


def nft(args, data=None):
    return subprocess.run(["nft", *args], input=data, capture_output=True, text=True, timeout=15)


def table_exists():
    r = nft(["list", "table", "inet", TABLE])
    return r.returncode == 0


def delete_table():
    if table_exists():
        nft(["delete", "table", "inet", TABLE])


def _port_set(ports):
    return "{ " + ", ".join(str(p) for p in ports) + " }"


def build_ruleset(state):
    """Render the full `inet smsgw` table for the given state dict."""
    policy = "drop" if state.get("default_policy") == "deny" else "accept"
    lines = [
        f"table inet {TABLE} {{",
        "  chain input {",
        "    type filter hook input priority -10; policy %s;" % policy,
        "    iif lo accept",
        "    ct state established,related accept",
        "    ct state invalid drop",
        "    ip protocol icmp accept",
        "    ip6 nexthdr ipv6-icmp accept",
        f"    tcp dport {_port_set(PROTECTED_TCP)} accept comment \"protected\"",
    ]
    for rule in state.get("rules", []):
        action = "accept" if rule.get("action") == "allow" else "drop"
        proto = rule.get("proto") or "tcp"
        parts = []
        src = rule.get("source")
        if src:
            fam = "ip6" if ":" in src else "ip"
            parts.append(f"{fam} saddr {src}")
        port = rule.get("port")
        if proto in ("tcp", "udp") and port:
            parts.append(f"{proto} dport {int(port)}")
        elif proto in ("tcp", "udp"):
            parts.append(f"meta l4proto {proto}")
        parts.append(action)
        lines.append("    " + " ".join(parts))
    lines += ["  }", "}"]
    return "\n".join(lines) + "\n"


def apply_state(state):
    """Replace our table with `state` (or remove it when disabled). Returns (ok, message)."""
    if not state.get("enabled"):
        delete_table()
        return True, "firewall disabled"
    ruleset = f"delete table inet {TABLE}\n" if table_exists() else ""
    ruleset += build_ruleset(state)
    r = nft(["-f", "-"], data=ruleset)
    if r.returncode != 0:
        # Best effort: make sure we didn't leave a half-applied table.
        delete_table()
        return False, (r.stderr or "nft failed").strip()
    return True, "applied"


def load_state():
    try:
        with open(STATE_FILE) as f:
            return json.load(f)
    except Exception:
        return {"enabled": False, "default_policy": "deny", "rules": []}


def save_state(state):
    os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
    tmp = STATE_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(state, f)
    os.replace(tmp, STATE_FILE)


def cancel_pending():
    global _pending_timer, _pending_deadline
    if _pending_timer:
        _pending_timer.cancel()
        _pending_timer = None
    _pending_deadline = 0.0


def current_status():
    committed = load_state()
    with _lock:
        pending = _pending_deadline > time.time()
        remaining = max(0, int(_pending_deadline - time.time())) if pending else 0
    return {
        "enabled": committed.get("enabled", False),
        "default_policy": committed.get("default_policy", "deny"),
        "rules": committed.get("rules", []),
        "protected_tcp_ports": PROTECTED_TCP,
        "pending_revert": pending,
        "revert_in_seconds": remaining,
        "table_active": table_exists(),
    }


def validate(state):
    if not isinstance(state.get("rules", []), list):
        raise ValueError("rules must be a list")
    if state.get("default_policy") not in ("allow", "deny"):
        raise ValueError("default_policy must be allow or deny")
    out = []
    for rule in state.get("rules", []):
        if rule.get("action") not in ("allow", "deny"):
            raise ValueError("rule.action must be allow or deny")
        proto = rule.get("proto") or "tcp"
        if proto not in ("tcp", "udp", "any"):
            raise ValueError("rule.proto must be tcp, udp or any")
        src = rule.get("source")
        if src is not None and not CIDR_RE.match(str(src)):
            raise ValueError(f"invalid source CIDR: {src}")
        port = rule.get("port")
        if port is not None and not (isinstance(port, int) and 1 <= port <= 65535):
            raise ValueError("rule.port must be 1-65535")
        out.append({"action": rule["action"], "proto": proto, "port": port, "source": src})
    return {"enabled": bool(state.get("enabled")), "default_policy": state["default_policy"], "rules": out}


def stage_apply(new_state):
    """Apply new_state now, but revert to the last committed state after REVERT_SECONDS."""
    global _pending_timer, _pending_deadline
    with _lock:
        previous = load_state()
        ok, msg = apply_state(new_state)
        if not ok:
            apply_state(previous)
            return False, msg
        cancel_pending()

        def _revert():
            with _lock:
                apply_state(load_state())  # back to last committed
                cancel_pending()

        _pending_timer = threading.Timer(REVERT_SECONDS, _revert)
        _pending_timer.daemon = True
        _pending_timer.start()
        _pending_deadline = time.time() + REVERT_SECONDS
        return True, msg


def commit():
    """Keep the currently-staged ruleset: persist it and stop the auto-revert."""
    global _staged
    with _lock:
        if not _staged:
            return False, "nothing staged"
        save_state(_staged)
        cancel_pending()
        return True, "committed"


_staged = None  # last staged (not yet committed) state


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _auth_ok(self):
        return TOKEN and self.headers.get("X-Fw-Token") == TOKEN

    def log_message(self, *a):
        pass

    def do_GET(self):
        if not self._auth_ok():
            return self._send(401, {"error": "unauthorized"})
        if self.path == "/status":
            return self._send(200, current_status())
        return self._send(404, {"error": "not found"})

    def do_POST(self):
        global _staged
        if not self._auth_ok():
            return self._send(401, {"error": "unauthorized"})
        length = int(self.headers.get("Content-Length", "0") or "0")
        raw = self.rfile.read(length) if length else b"{}"
        try:
            payload = json.loads(raw or b"{}")
        except Exception:
            return self._send(400, {"error": "invalid json"})
        try:
            if self.path == "/apply":
                state = validate(payload)
                _staged = state
                ok, msg = stage_apply(state)
                return self._send(200 if ok else 400, {"ok": ok, "message": msg, **current_status()})
            if self.path == "/commit":
                ok, msg = commit()
                return self._send(200 if ok else 400, {"ok": ok, "message": msg, **current_status()})
            if self.path == "/revert":
                with _lock:
                    apply_state(load_state())
                    cancel_pending()
                return self._send(200, {"ok": True, "message": "reverted", **current_status()})
        except ValueError as e:
            return self._send(400, {"error": str(e)})
        return self._send(404, {"error": "not found"})


class Server(ThreadingMixIn, UnixStreamServer):
    daemon_threads = True


def main():
    if not TOKEN:
        raise SystemExit("FW_AGENT_TOKEN is required")
    # Reboot-safe: reapply the last committed state.
    with _lock:
        apply_state(load_state())
    os.makedirs(os.path.dirname(SOCKET_PATH), exist_ok=True)
    if os.path.exists(SOCKET_PATH):
        os.unlink(SOCKET_PATH)
    srv = Server(SOCKET_PATH, Handler)
    # The volume is private to the agent + api containers; access is still gated by FW_AGENT_TOKEN.
    os.chmod(SOCKET_PATH, 0o666)
    print(f"fwagent listening on {SOCKET_PATH}; protected tcp ports {PROTECTED_TCP}", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
