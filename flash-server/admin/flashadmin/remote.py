"""Shell command builders for the Ubuntu box (pure, testable). Layout per API.md "Server layout on Ubuntu"."""
from __future__ import annotations

import re
import shlex
from typing import List, Optional

SERVICE = "flash-server"
CODE_DIR = "/opt/flash-server"
CONFIG = "/etc/flash-server/config.json"
DATA_DIR = "/var/lib/flash-server"
SERVICE_USER = "flash"
MIN_PYTHON = (3, 10)


def q(s: str) -> str:
    return shlex.quote(s)


def sudo(cmd: str, with_password: bool, user: Optional[str] = None) -> str:
    """Wrap a shell command for sudo. With a password, sudo reads it from stdin (-S) and prints no prompt."""
    flags = "-S -p ''" if with_password else "-n"
    as_user = f" -u {q(user)}" if user else ""
    return f"sudo {flags}{as_user} bash -c {q(cmd)}"


def install_command(workdir: str, bundle: str, port: Optional[int] = None, bind_public: bool = False,
                    open_firewall: bool = False) -> str:
    """Extract the bundle in workdir and run deploy/install.sh (the caller wraps it in sudo)."""
    args: List[str] = []
    if bind_public:
        args += ["--host", "0.0.0.0"]
    if port:
        args += ["--port", str(int(port))]
    if open_firewall:
        args.append("--open-firewall")
    tail = (" " + " ".join(q(a) for a in args)) if args else ""
    return f"cd {q(workdir)} && tar xzf {q(bundle)} && bash deploy/install.sh{tail}"


def cli(subcommand: str, *args: str) -> str:
    """`python3 -m flashserver …` run as the service user (caller wraps with sudo(user=flash))."""
    rest = " ".join(q(a) for a in args)
    return (f"cd {CODE_DIR} && PYTHONPATH={CODE_DIR} python3 -m flashserver {q(subcommand)}"
            f"{' ' + rest if rest else ''} --config {CONFIG} --json")


def systemctl(action: str) -> str:
    if action not in ("start", "stop", "restart", "status", "enable", "disable"):
        raise ValueError(action)
    return f"systemctl {action} {SERVICE}"


STATUS_COMMAND = (f"systemctl show {SERVICE} --no-pager "
                  "-p ActiveState -p SubState -p MainPID -p ActiveEnterTimestamp -p LoadState")


def journal_command(lines: int = 200, follow: bool = True) -> str:
    return f"journalctl -u {SERVICE} -n {int(lines)} --no-pager -o short-iso{' -f' if follow else ''}"


PREREQ_COMMAND = (
    "echo PY=$(python3 -c 'import sys;print(\"%d.%d.%d\"%sys.version_info[:3])' 2>/dev/null || echo none);"
    " echo OS=$( (. /etc/os-release 2>/dev/null && echo \"$PRETTY_NAME\") || uname -sr);"
    " echo SYSTEMD=$(systemctl --version 2>/dev/null | head -1 | awk '{print $2}');"
    " echo DISK=$(df -PB1 /var/lib 2>/dev/null | awk 'NR==2{print $4}');"
    " echo TMP=$(df -PB1 /tmp 2>/dev/null | awk 'NR==2{print $4}');"
    " echo SUDO=$(sudo -n true 2>/dev/null && echo nopasswd || echo password)"
)


def parse_kv(output: str, sep: str = "=") -> dict:
    out = {}
    for line in output.splitlines():
        if sep in line:
            k, v = line.split(sep, 1)
            out[k.strip()] = v.strip()
    return out


def evaluate_prereqs(output: str, min_free: int = 1 << 30) -> List[dict]:
    """[{name, ok, value, hint}] from PREREQ_COMMAND output."""
    kv = parse_kv(output)
    checks: List[dict] = []
    py = kv.get("PY", "none")
    m = re.match(r"(\d+)\.(\d+)", py)
    py_ok = bool(m) and (int(m.group(1)), int(m.group(2))) >= MIN_PYTHON
    checks.append({"name": "Python 3.10+", "ok": py_ok, "value": py,
                   "hint": "" if py_ok else "sudo apt install python3"})
    checks.append({"name": "Operating system", "ok": "ubuntu" in kv.get("OS", "").lower() or None,
                   "value": kv.get("OS", "?"), "hint": ""})
    sd = kv.get("SYSTEMD", "")
    checks.append({"name": "systemd", "ok": bool(sd), "value": sd or "missing", "hint": ""})
    for key, label in (("DISK", "Free disk (/var/lib)"), ("TMP", "Free disk (/tmp)")):
        try:
            free = int(kv.get(key, ""))
        except ValueError:
            free = -1
        checks.append({"name": label, "ok": free >= min_free, "value": free, "hint": "" if free >= min_free else "need ≥ 1 GB"})
    checks.append({"name": "sudo", "ok": True, "value": kv.get("SUDO", "?"), "hint": ""})
    return checks


def parse_status(output: str) -> dict:
    kv = parse_kv(output)
    return {
        "active": kv.get("ActiveState", "unknown"),
        "sub": kv.get("SubState", ""),
        "pid": kv.get("MainPID", ""),
        "since": kv.get("ActiveEnterTimestamp", ""),
        "loaded": kv.get("LoadState", ""),
    }
