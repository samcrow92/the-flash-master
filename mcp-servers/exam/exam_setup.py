"""EXAM environment setup: find the installation, install the RESTapi plugin, and check every prerequisite.

The RESTapi plugin is MicroNova's licensed software, so it is not shipped with TheFlashMaster. The company provides it
as a package (file share path or an http(s) URL, e.g. a department marketplace server), set in Settings → EXAM →
RESTapi plugin package. EXAM is an Eclipse RCP application, so the plugin is installed the Eclipse way:
  - .jar, or a .zip with plugins/ (and features/)      -> a dropins folder
  - .zip that is a p2 repository (content.jar/.xml)     -> p2 director into the EXAM installation
When the EXAM folder is not writable (Program Files without admin rights) the plugin goes to a per-user dropins folder,
which exam_start passes to EXAM (org.eclipse.equinox.p2.reconciler.dropins.directory).
"""
from __future__ import annotations

import glob
import os
import re
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.parse
import urllib.request
import zipfile
from typing import Any

import exam_tools as X

PLUGIN_RE = re.compile(r"rest", re.I)  # p2 installable units
PLUGIN_FILE_RE = re.compile(r"rest[._\-]?api|(exam|micronova).*rest|rest.*(exam|micronova)", re.I)


def user_dropins() -> str:
    p = X.env("EXAM_USER_DROPINS") or os.path.join(os.path.expanduser("~"), ".theflashmaster", "exam-dropins")
    os.makedirs(p, exist_ok=True)
    return p


# ---------------------------------------------------------------- find the installation

def _version(home: str) -> str:
    for name in (".eclipseproduct", "version.txt"):
        f = os.path.join(home, name)
        if os.path.isfile(f):
            with open(f, encoding="utf-8", errors="replace") as fh:
                m = re.search(r"version\s*[=:]\s*([\w.\-]+)", fh.read())
                if m:
                    return m.group(1)
    m = re.search(r"(\d+\.\d+(?:\.\d+)?)", os.path.basename(home.rstrip("\\/")))
    return m.group(1) if m else ""


def _registry_locations() -> list[str]:
    try:
        import winreg  # type: ignore
    except ImportError:
        return []
    out: list[str] = []
    for hive in (winreg.HKEY_LOCAL_MACHINE, winreg.HKEY_CURRENT_USER):
        for base in (r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall", r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"):
            try:
                root = winreg.OpenKey(hive, base)
            except OSError:
                continue
            for i in range(winreg.QueryInfoKey(root)[0]):
                try:
                    k = winreg.OpenKey(root, winreg.EnumKey(root, i))
                    name = str(winreg.QueryValueEx(k, "DisplayName")[0])
                    if re.search(r"\bEXAM\b", name):
                        loc = str(winreg.QueryValueEx(k, "InstallLocation")[0])
                        if loc:
                            out.append(loc)
                except OSError:
                    continue
    return out


def find_installs() -> list[dict[str, str]]:
    cands: list[str] = []
    if X.env("EXAM_HOME"):
        cands.append(X.env("EXAM_HOME"))
    cands += _registry_locations()
    roots = [os.environ.get(k, "") for k in ("ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "LOCALAPPDATA")] + ["C:\\", "D:\\"]
    for r in filter(None, roots):
        for pat in ("MicroNova*/EXAM*/EXAM.exe", "MicroNova*/EXAM.exe", "EXAM*/EXAM.exe", "MicroNova*/*/EXAM.exe"):
            cands += [os.path.dirname(p) for p in glob.glob(os.path.join(r, pat))]
    seen, out = set(), []
    for c in cands:
        home = os.path.dirname(c) if c.lower().endswith(".exe") else c
        key = os.path.normcase(os.path.abspath(home))
        if key in seen or not os.path.isfile(os.path.join(home, "EXAM.exe")):
            continue
        seen.add(key)
        out.append({"home": home, "version": _version(home)})
    return sorted(out, key=lambda d: d["version"], reverse=True)


# ---------------------------------------------------------------- plugin detection / install

def find_plugin(home: str) -> list[str]:
    hits: list[str] = []
    for d in (os.path.join(home, "plugins"), os.path.join(home, "dropins"), user_dropins()):
        if not os.path.isdir(d):
            continue
        for p in glob.glob(os.path.join(d, "**", "*"), recursive=True):
            n = os.path.basename(p)
            if PLUGIN_FILE_RE.search(n) and (n.endswith(".jar") or os.path.isdir(p)):
                hits.append(os.path.relpath(p, home) if p.startswith(home) else p)
            if len(hits) >= 5:
                return hits
    return hits


def _fetch(package: str) -> str:
    if re.match(r"https?://", package, re.I):
        name = os.path.basename(urllib.parse.urlparse(package).path) or "exam-restapi.zip"
        dest = os.path.join(tempfile.gettempdir(), f"flash_exam_{int(time.time())}_{name}")
        with urllib.request.urlopen(package, timeout=300) as r, open(dest, "wb") as fh:  # env proxies apply
            shutil.copyfileobj(r, fh)
        return dest
    if not os.path.exists(package):
        raise RuntimeError(f"plugin package not found: {package}")
    return package


def _writable(d: str) -> bool:
    try:
        os.makedirs(d, exist_ok=True)
        probe = os.path.join(d, ".flash_write_test")
        with open(probe, "w") as fh:
            fh.write("x")
        os.remove(probe)
        return True
    except OSError:
        return False


def _mark_clean(target: str) -> None:
    with open(os.path.join(user_dropins(), ".pending-clean"), "w") as fh:
        fh.write(target)


def _p2_install(home: str, repo_zip: str) -> str:
    exe = os.path.join(home, "EXAM.exe")
    repo = "jar:" + urllib.parse.urljoin("file:", urllib.request.pathname2url(os.path.abspath(repo_zip))) + "!/"
    base = [exe, "-nosplash", "-consoleLog", "-application", "org.eclipse.equinox.p2.director", "-repository", repo]
    r = subprocess.run(base + ["-list"], capture_output=True, text=True, timeout=600)
    ius = [ln.split("=")[0].strip() for ln in (r.stdout + r.stderr).splitlines() if "=" in ln and PLUGIN_RE.search(ln)]
    groups = [i for i in ius if i.endswith(".feature.group")] or ius
    if not groups:
        raise RuntimeError("p2 repository contains no RESTapi installable unit:\n" + (r.stdout + r.stderr)[-800:])
    r = subprocess.run(base + ["-installIU", ",".join(groups)], capture_output=True, text=True, timeout=1800)
    if r.returncode != 0:
        raise RuntimeError("p2 install failed (EXAM folder not writable? run once as administrator):\n" + (r.stdout + r.stderr)[-800:])
    return f"installed {', '.join(groups)} into {home} with the p2 director"


def install_plugin(home: str, package: str) -> str:
    if not home or not os.path.isfile(os.path.join(home, "EXAM.exe")):
        raise RuntimeError("EXAM installation not found — set Settings → EXAM → Install folder")
    if not package:
        raise RuntimeError("no plugin package set — Settings → EXAM → RESTapi plugin package (file share path or URL from your EXAM admin / MicroNova)")
    src = _fetch(package)
    global_dropins = os.path.join(home, "dropins")
    target = global_dropins if _writable(global_dropins) else user_dropins()
    if src.lower().endswith(".jar"):
        shutil.copy2(src, target)
        _mark_clean(target)
        return f"copied {os.path.basename(src)} to {target}"
    if not zipfile.is_zipfile(src):
        raise RuntimeError(f"unsupported plugin package (expected .jar or .zip): {src}")
    with zipfile.ZipFile(src) as z:
        names = z.namelist()
        top = {n.split("/")[0] for n in names}
        if top & {"content.jar", "content.xml", "artifacts.jar", "artifacts.xml", "compositeContent.xml"}:
            return _p2_install(home, src)
        dest = os.path.join(target, os.path.splitext(os.path.basename(src))[0])
        if any(n.startswith(("plugins/", "features/", "eclipse/")) or "/plugins/" in n for n in names):
            z.extractall(dest)
        else:
            jars = [n for n in names if n.endswith(".jar")]
            if not jars:
                raise RuntimeError("zip has no plugins/ folder, p2 repository or .jar files")
            os.makedirs(dest, exist_ok=True)
            for n in jars:
                with z.open(n) as fi, open(os.path.join(dest, os.path.basename(n)), "wb") as fo:
                    shutil.copyfileobj(fi, fo)
    _mark_clean(target)
    return f"extracted to {dest}" + ("" if target == global_dropins else " (per-user dropins: EXAM must be started by TheFlashMaster)")


# ---------------------------------------------------------------- checks

def _tcp(host: str, port: int, timeout: float = 4) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def check(home: str = "") -> list[dict[str, str]]:
    out: list[dict[str, str]] = []

    def add(name: str, state: str, detail: str) -> None:
        out.append({"name": name, "state": state, "detail": detail})

    home = home or X.env("EXAM_HOME")
    if home and os.path.isfile(os.path.join(home, "EXAM.exe")):
        add("EXAM installation", "ok", f"{home} {_version(home)}".strip())
        plug = find_plugin(home)
        add("RESTapi plugin", "ok" if plug else "fail", ", ".join(plug) if plug else "not found — set the plugin package and run Set up")
    else:
        add("EXAM installation", "warn" if not home else "fail", "not set (only needed to start EXAM from the app)" if not home else f"EXAM.exe not in {home}")
    lh, lp = X.env("EXAM_LICENSE_HOST"), X.env("EXAM_LICENSE_PORT")
    if lh and lp and lp != "0":
        add("License server", "ok" if _tcp(lh, int(lp)) else "fail", f"{lh}:{lp}" + ("" if _tcp(lh, int(lp)) else " not reachable"))
    else:
        add("License server", "warn", "host/port not set")
    target = X.env("EXAM_TARGET_ENDPOINT")
    if target:
        u = urllib.parse.urlparse(target if "://" in target else "http://" + target)
        reach = _tcp(u.hostname or "", u.port or (443 if u.scheme == "https" else 80))
        add("Application server", "ok" if reach else "fail", target + ("" if reach else " not reachable"))
    else:
        add("Application server", "warn", "URL not set")
    add("Default model", "ok" if X.env("EXAM_MODEL") else "warn", X.env("EXAM_MODEL") or "not set (the agent will ask)")
    try:
        st = X.status()
        add("RESTapi", "ok", f"{st['url']} api {st.get('api', '?')}")
    except RuntimeError:
        add("RESTapi", "warn", f"{X.base_url()} not answering (EXAM not running — exam_start starts it)")
    return out


def setup(package: str = "", install: bool = True) -> dict[str, Any]:
    """Detect EXAM, install the RESTapi plugin when missing (and a package is set), then run all checks."""
    actions: list[str] = []
    installs = find_installs()
    home = X.env("EXAM_HOME") or (installs[0]["home"] if installs else "")
    if not X.env("EXAM_HOME") and home:
        actions.append(f"found EXAM at {home}")
    pkg = package or X.env("EXAM_PLUGIN_PACKAGE")
    if install and home and not find_plugin(home) and pkg:
        try:
            actions.append(install_plugin(home, pkg))
        except (RuntimeError, OSError, subprocess.SubprocessError) as e:
            actions.append(f"plugin install failed: {e}")
    checks = check(home)
    return {"home": home, "installs": installs, "actions": actions, "checks": checks,
            "ok": all(c["state"] != "fail" for c in checks)}
