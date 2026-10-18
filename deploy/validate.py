#!/usr/bin/env python3
"""Static checks for the deploy/ bundle. Docker is not needed.

    python3 deploy/validate.py            (exit status 0 = all checks passed)

Checks:
  * docker-compose.prod.yml parses (PyYAML). Compose-style ${VAR}, ${VAR:-default},
    ${VAR:?error} and $$ interpolation is evaluated twice: with an empty environment, which must
    fail on exactly the required secrets, and with a fully filled one, which must succeed
  * every variable the compose file references is documented in .env.example
  * network isolation: data stores only on internal networks; only web 3001, api 3000 and SMPP 2775
    are published
  * restart policy and healthcheck on every long-running service; depends_on targets exist and
    never point at profile-only services
  * build Dockerfiles exist, are multi-stage and switch to a non-root USER
  * host paths of bind mounts exist
  * `bash -n` syntax check of every deploy shell script, plus shellcheck when it is installed
  * client-IP safety: web/api publish on 127.0.0.1 by default (and in .env.example) and the api
    gets TRUSTED_PROXIES, so X-Forwarded-For cannot be spoofed by hitting web/api directly
  * nginx.conf (when nginx is installed): `nginx -t` on a copy with throwaway certs/paths, and a
    live run of its access-log format proving ?api_key= values never reach the access log
"""
from __future__ import annotations

import os
import re
import http.client
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

try:
    import yaml
except ImportError:  # pragma: no cover
    sys.exit("validate: PyYAML is required (apt install python3-yaml / pip install pyyaml)")

DEPLOY = Path(__file__).resolve().parent
COMPOSE = DEPLOY / "docker-compose.prod.yml"
ENV_EXAMPLE = DEPLOY / ".env.example"
NGINX_CONF = DEPLOY / "nginx.conf"

REQUIRED_SECRETS = {
    "POSTGRES_PASSWORD", "SMS_API_DB_PASSWORD", "SMS_ENGINE_DB_PASSWORD", "REDIS_PASSWORD",
    "INTERNAL_TOKEN", "APP_ENC_KEY", "JWT_SECRET",
}
EXPECTED_PUBLISHED = {"web": 3001, "api": 3000, "engine": 2775}
DATA_STORES = {"postgres", "redis"}
ONE_SHOT = {"db-init", "seed"}
FOREIGN_SCRIPTS = {"e2e.sh"}

failures: list[str] = []
passes = 0


def check(cond: bool, msg: str) -> None:
    global passes
    if cond:
        passes += 1
    else:
        failures.append(msg)


VAR_RE = re.compile(r"\$\$|\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-?])([^}]*))?\}|\$([A-Za-z_][A-Za-z0-9_]*)")


class InterpolationError(Exception):
    pass


def interpolate(text: str, env: dict[str, str]) -> str:
    """Docker Compose interpolation subset used by the file ($$, ${V}, ${V:-d}, ${V-d}, ${V:?e})."""
    def repl(m: re.Match) -> str:
        if m.group(0) == "$$":
            return "$"
        name = m.group(1) or m.group(4)
        op, arg = m.group(2), m.group(3)
        val = env.get(name)
        if op == ":-":
            return val if val else arg
        if op == "-":
            return val if val is not None else arg
        if op == ":?":
            if not val:
                raise InterpolationError(f"{name}: {arg}")
            return val
        if op == "?":
            if val is None:
                raise InterpolationError(f"{name}: {arg}")
            return val
        return val or ""
    return VAR_RE.sub(repl, text)


def interpolate_tree(node, env):
    """Interpolate every scalar; collect all errors (like compose, which reports the first)."""
    errors: list[str] = []

    def walk(n):
        if isinstance(n, dict):
            return {k: walk(v) for k, v in n.items()}
        if isinstance(n, list):
            return [walk(v) for v in n]
        if isinstance(n, str):
            try:
                return interpolate(n, env)
            except InterpolationError as e:
                errors.append(str(e))
                return ""
        return n

    return walk(node), errors


def env_example_vars() -> dict[str, str]:
    out = {}
    for line in ENV_EXAMPLE.read_text().splitlines():
        m = re.match(r"^([A-Z_][A-Z0-9_]*)=(.*)$", line)
        if m:
            out[m.group(1)] = m.group(2)
    return out


def main() -> int:
    raw_text = COMPOSE.read_text()
    raw = yaml.safe_load(raw_text)
    check(isinstance(raw, dict) and "services" in raw, "compose: no services")
    services: dict = raw["services"]

    # --- variables documented -------------------------------------------------------------
    referenced = {m.group(1) or m.group(4) for m in VAR_RE.finditer(raw_text) if m.group(0) != "$$"}
    # $$VAR inside container commands is shell expansion, not compose interpolation.
    referenced -= {None}
    documented = env_example_vars()
    for v in sorted(referenced - set(documented)):
        failures.append(f".env.example: {v} is used by the compose file but not documented")
    check(REQUIRED_SECRETS <= set(documented), ".env.example: a required secret is missing")
    for v in REQUIRED_SECRETS:
        check(documented.get(v, "x") == "", f".env.example: {v} must be empty (no default secret)")

    # --- interpolation: empty env must fail on exactly the required secrets -----------------
    _, errs = interpolate_tree(raw, {})
    failing = {e.split(":", 1)[0] for e in errs}
    check(failing == REQUIRED_SECRETS,
          f"compose: with an empty env the required vars should be exactly {sorted(REQUIRED_SECRETS)}, got {sorted(failing)}")

    filled = dict(documented)
    for v in REQUIRED_SECRETS:
        filled[v] = "0123456789abcdef0123456789abcdef"
    filled["APP_ENC_KEY"] = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
    resolved, errs = interpolate_tree(raw, filled)
    check(not errs, f"compose: interpolation failed with a filled .env: {errs}")
    services_r: dict = resolved["services"]

    # --- networks ------------------------------------------------------------------------
    nets = resolved.get("networks", {})
    check(nets.get("data", {}).get("internal") is True, "networks: data must be internal")
    check(nets.get("backend", {}).get("internal") is True, "networks: backend must be internal")
    for name in DATA_STORES:
        s = services_r.get(name, {})
        check(set(s.get("networks", [])) == {"data"}, f"{name}: must be only on the internal data network")
        check(not s.get("ports"), f"{name}: must not publish ports")

    # --- published ports -------------------------------------------------------------------
    published = {}
    for name, s in services_r.items():
        for p in s.get("ports", []) or []:
            parts = str(p).split(":")
            published.setdefault(name, set()).add(int(parts[-1].split("/")[0]))
            check(len(parts) == 3, f"{name}: port {p} should be addr:host:container")
    check(published == {k: {v} for k, v in EXPECTED_PUBLISHED.items()},
          f"ports: expected only {EXPECTED_PUBLISHED}, got {published}")

    # --- client IP safety: X-Forwarded-For must only come through nginx -----------------------
    secrets_only = {v: filled[v] for v in REQUIRED_SECRETS}
    defaults_r, errs = interpolate_tree(raw, secrets_only)
    check(not errs, f"compose: interpolation failed with only the secrets set: {errs}")
    for label, svcs in (("compose defaults", defaults_r["services"]), (".env.example", services_r)):
        for name in ("web", "api"):
            for p in svcs[name].get("ports", []) or []:
                check(str(p).split(":")[0] == "127.0.0.1",
                      f"{label}: {name} port {p} must bind 127.0.0.1 (TRUST_PROXY=1 + public web/api = spoofable IP whitelists)")
        check(bool(svcs["api"]["environment"].get("TRUSTED_PROXIES")), f"{label}: api TRUSTED_PROXIES not set")
    check(documented.get("PUBLISH_ADDR") == "127.0.0.1", ".env.example: PUBLISH_ADDR must default to 127.0.0.1")

    # --- services: restart, healthcheck, depends_on, profiles -------------------------------
    for name, s in services.items():
        profiled = bool(s.get("profiles"))
        if name in ONE_SHOT:
            check(s.get("restart") == "no", f"{name}: one-shot service must have restart: \"no\"")
        else:
            check(s.get("restart") in ("unless-stopped", "always"), f"{name}: needs a restart policy")
            if name != "db-maint":
                check("healthcheck" in s, f"{name}: needs a healthcheck")
        check("logging" in s, f"{name}: should configure log rotation")
        deps = s.get("depends_on") or {}
        for dep, cond in (deps.items() if isinstance(deps, dict) else ((d, {}) for d in deps)):
            check(dep in services, f"{name}: depends_on unknown service {dep}")
            if dep in services and not profiled:
                check(not services[dep].get("profiles"), f"{name}: depends on profile-only service {dep}")
            c = (cond or {}).get("condition", "service_started")
            check(c in ("service_started", "service_healthy", "service_completed_successfully"),
                  f"{name}: bad depends_on condition {c}")
            if c == "service_healthy" and dep in services:
                check("healthcheck" in services[dep], f"{name}: waits for {dep} healthy but it has no healthcheck")
        for vol in s.get("volumes", []) or []:
            src = str(vol).split(":")[0]
            if src.startswith(".") or src.startswith("/"):
                check((DEPLOY / src).exists(), f"{name}: bind mount source {src} does not exist")
        if "build" in s:
            b = s["build"]
            df = (DEPLOY / b.get("context", ".") / b["dockerfile"]).resolve()
            check(df.is_file(), f"{name}: Dockerfile {df} missing")
            if df.is_file():
                text = df.read_text()
                stages = re.findall(r"(?im)^FROM\s", text)
                check(len(stages) >= 2, f"{df.name}: should be multi-stage")
                users = re.findall(r"(?im)^USER\s+(\S+)", text)
                check(bool(users) and users[-1] not in ("root", "0", "0:0"), f"{df.name}: final stage must run as non-root")
                check(re.search(r"(?im)^HEALTHCHECK\s", text) is not None, f"{df.name}: no HEALTHCHECK")
                ign = df.with_name(df.name + ".dockerignore")
                check(ign.is_file(), f"{df.name}: missing {ign.name}")
            for k, v in (b.get("args") or {}).items():
                check(re.search(rf"(?m)^ARG {k}\b", df.read_text() if df.is_file() else "") is not None,
                      f"{name}: build arg {k} not declared in {df.name}")

    check(services["engine"]["depends_on"]["db-init"]["condition"] == "service_completed_successfully",
          "engine must wait for db-init to complete")
    check(services["api"]["depends_on"]["db-init"]["condition"] == "service_completed_successfully",
          "api must wait for db-init to complete")
    check("sim" in (services.get("smsc-sim", {}).get("profiles") or []), "smsc-sim must be under profile sim")
    redis_cmd = " ".join(services_r["redis"]["command"])
    check("--appendonly yes" in redis_cmd and "noeviction" in redis_cmd, "redis: AOF + noeviction required")
    check(services_r["postgres"]["image"].startswith("postgres:16"), "postgres must be 16")
    check(services_r["redis"]["image"].startswith("redis:7"), "redis must be 7")
    eng_env = services_r["engine"]["environment"]
    api_env = services_r["api"]["environment"]
    for k in ("DATABASE_URL", "REDIS_URL", "INTERNAL_TOKEN", "APP_ENC_KEY"):
        check(bool(eng_env.get(k)), f"engine: {k} not set")
    for k in ("DATABASE_URL", "DATABASE_URL_PRIVILEGED", "REDIS_URL", "INTERNAL_TOKEN", "ENGINE_URL", "APP_ENC_KEY", "JWT_SECRET"):
        check(bool(api_env.get(k)), f"api: {k} not set")
    check("sms_api_login" in api_env["DATABASE_URL"] and "sms_engine_login" in api_env["DATABASE_URL_PRIVILEGED"],
          "api: tenant pool must use the RLS role, privileged pool the engine role")

    # --- shell scripts ----------------------------------------------------------------------
    # deploy/e2e.sh belongs to the integration suite: syntax-checked here, style rules not enforced.
    all_scripts = sorted(list(DEPLOY.glob("*.sh")) + list(DEPLOY.glob("init/*.sh")))
    scripts = [p for p in all_scripts if p.name not in FOREIGN_SCRIPTS]
    for script in all_scripts:
        r = subprocess.run(["bash", "-n", str(script)], capture_output=True, text=True)
        check(r.returncode == 0, f"{script.name}: bash -n failed: {r.stderr.strip()}")
        check(os.access(script, os.X_OK), f"{script.name}: not executable")
    for script in scripts:
        first = script.read_text().splitlines()[0]
        check(first == "#!/usr/bin/env bash", f"{script.name}: shebang should be #!/usr/bin/env bash")
        check(re.search(r"set -E?euo pipefail", script.read_text()) is not None, f"{script.name}: missing set -euo pipefail")

    # shellcheck, when available (PATH or $SHELLCHECK); skipped with a note otherwise.
    sc = os.environ.get("SHELLCHECK") or shutil.which("shellcheck")
    if sc:
        r = subprocess.run([sc, "-x", *map(str, scripts)], capture_output=True, text=True, cwd=DEPLOY)
        check(r.returncode == 0, f"shellcheck:\n{r.stdout.strip()}")
    else:
        print("validate: note: shellcheck not found (set SHELLCHECK=/path/to/shellcheck); skipped")

    check_nginx()

    if failures:
        for f in failures:
            print(f"FAIL - {f}")
        print(f"validate: {len(failures)} failed, {passes} passed")
        return 1
    print(f"validate: ALL DEPLOY CHECKS PASSED ({passes} assertions)")
    return 0


def free_port() -> int:
    with socket.socket() as sk:
        sk.bind(("127.0.0.1", 0))
        return sk.getsockname()[1]


def check_nginx() -> None:
    """nginx -t on nginx.conf, then a live run of its log_format: API keys must never be logged."""
    nginx = os.environ.get("NGINX") or shutil.which("nginx") or ("/usr/sbin/nginx" if os.access("/usr/sbin/nginx", os.X_OK) else None)
    if not nginx:
        print("validate: note: nginx not found (set NGINX=/path/to/nginx); nginx checks skipped")
        return
    text = NGINX_CONF.read_text()
    with tempfile.TemporaryDirectory(prefix="smsgw-nginx-") as tmp:
        t = Path(tmp)
        (t / "logs").mkdir()
        crt, key = t / "c.pem", t / "k.pem"
        r = subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=t",
                            "-keyout", str(key), "-out", str(crt)], capture_output=True, text=True)
        if r.returncode == 0:
            full = re.sub(r"ssl_certificate\s+\S+;", f"ssl_certificate {crt};", text)
            full = re.sub(r"ssl_certificate_key\s+\S+;", f"ssl_certificate_key {key};", full)
            full = full.replace("/var/log/nginx/", f"{t}/logs/").replace("pid /run/nginx.pid;", f"pid {t}/nginx.pid;")
            if os.geteuid() != 0:
                full = re.sub(r"(?m)^user\s+\S+;", "", full)
            (t / "full.conf").write_text(full)
            # default prefix: modules-enabled/*.conf load modules by prefix-relative paths
            r = subprocess.run([nginx, "-t", "-q", "-c", str(t / "full.conf"), "-e", f"{t}/logs/error.log"],
                               capture_output=True, text=True)
            ok = r.returncode == 0
            if not ok and "unknown directive \"stream\"" in r.stderr:
                print("validate: note: nginx has no stream module; nginx -t skipped")
            else:
                check(ok, f"nginx -t nginx.conf failed: {r.stderr.strip()}")
        else:
            print("validate: note: openssl unavailable; nginx -t skipped")

        # Live log test with the exact map + log_format from nginx.conf.
        m_map = re.search(r"(?ms)^\s*map \$request \$request_log \{.*?^\s*\}", text)
        m_fmt = re.search(r"(?ms)^\s*log_format main .*?;\s*$", text)
        check(m_map is not None and m_fmt is not None, "nginx.conf: map $request $request_log / log_format main not found")
        check(re.search(r"access_log\s+\S+\s+main;", text) is not None, "nginx.conf: access_log must use format main")
        if m_map is None or m_fmt is None:
            return
        check('"$request"' not in m_fmt.group(0), "nginx.conf: log_format main must not log the raw $request")
        port = free_port()
        log = t / "logs" / "access.log"
        (t / "log.conf").write_text(f"""
pid {t}/log.pid;
error_log {t}/logs/log-error.log warn;
events {{ worker_connections 64; }}
http {{
{m_map.group(0)}
{m_fmt.group(0)}
    access_log {log} main;
    server {{
        listen 127.0.0.1:{port};
        location / {{ return 204; }}
    }}
}}
""")
        r = subprocess.run([nginx, "-c", str(t / "log.conf"), "-p", tmp, "-e", f"{t}/logs/log-error.log"],
                           capture_output=True, text=True)
        check(r.returncode == 0, f"nginx log test: start failed: {r.stderr.strip()}")
        if r.returncode != 0:
            return
        secret = "sk_live_" + "Q" * 40
        cases = [
            (f"/v1/sms/send?api_key={secret}&to=919876543210&text=hi", "/v1/sms/send?[redacted]"),
            (f"/v1/sms/send?to=919876543210&API_KEY={secret}", "/v1/sms/send?[redacted]"),
            (f"/v1/sms/send?api%5Fkey={secret}", "/v1/sms/send?[redacted]"),
            ("/api/messages?status=DELIVERED&limit=50", "/api/messages?status=DELIVERED&limit=50"),
        ]
        try:
            for path, _ in cases:
                c = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
                c.request("GET", path)
                c.getresponse().read()
                c.close()
            deadline = time.time() + 5
            lines: list[str] = []
            while time.time() < deadline:
                lines = log.read_text().splitlines() if log.exists() else []
                if len(lines) >= len(cases):
                    break
                time.sleep(0.05)
        finally:
            pid = (t / "log.pid").read_text().strip() if (t / "log.pid").exists() else ""
            subprocess.run([nginx, "-c", str(t / "log.conf"), "-p", tmp, "-e", f"{t}/logs/log-error.log", "-s", "stop"],
                           capture_output=True)
            if pid:
                for _ in range(50):
                    if not Path(f"/proc/{pid}").exists():
                        break
                    time.sleep(0.05)
        check(len(lines) == len(cases), f"nginx log test: expected {len(cases)} lines, got {lines}")
        body = "\n".join(lines)
        check(secret not in body and "QQQQQQQQ" not in body, f"nginx log test: API key leaked into the access log:\n{body}")
        for (_, expect), line in zip(cases, lines):
            check(f'"GET {expect} HTTP/1.1"' in line, f"nginx log test: expected request {expect!r} in {line!r}")


if __name__ == "__main__":
    sys.exit(main())
