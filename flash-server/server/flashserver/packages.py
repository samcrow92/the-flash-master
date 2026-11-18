"""Plugin package validation, kinds, review diffs and reading a plugins-src/<id>/ folder (port of build-index.mjs)."""
from __future__ import annotations

import json
import re
from pathlib import Path

from .util import ID_RE, NAME_RE, VERSION_RE, ApiError, bad, json_bytes

MAX_PACKAGE = 2_000_000  # same as the app's MAX_PACKAGE (bytes of the published JSON)
MAX_SCRIPT = 200_000  # bytes, same as the app
MAX_ITEMS = 200
MD_RE = re.compile(r"^[\w.-]+\.md$", re.ASCII)
SCRIPT_RE = re.compile(r"^[\w.-]+\.(py|ps1|sh|js|mjs|bat|cmd|txt|json|ya?ml)$", re.ASCII)
AGENT_HDR = re.compile(r"^---\n(?:[\s\S]*?\n)?name:\s*[a-z][a-z0-9-]+[\s\S]*?\n---")
COMMAND_RE = re.compile(r"^[a-z][a-z0-9-]{1,40}$")
FRONT_RE = re.compile(r"^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$")
WORKFLOW_HDR = re.compile(r"^---\n(?:[\s\S]*?\n)?command:\s*[a-z][a-z0-9-]+[\s\S]*?\n---")
EXAM_KEYS = ("pluginPackage", "targetEndpoint", "licenseHost", "licensePort", "restPort", "modelName",
             "modelConfigUuid", "systemConfig", "reportProject", "pythonPath")
ITEM_KINDS = (("agents", "agent", MD_RE), ("workflows", "workflow", MD_RE), ("skills", "skill", MD_RE), ("scripts", "script", SCRIPT_RE))


def _text(v, field: str, limit: int, required: bool = False) -> str:
    if v is None:
        v = ""
    if not isinstance(v, str):
        raise bad(f"{field} must be a string")
    v = v.replace("\r\n", "\n")
    if required and not v.strip():
        raise bad(f"{field} is required")
    if len(v) > limit:
        raise bad(f"{field} is too long (max {limit} characters)")
    return v


def validate(raw) -> dict:
    """Return the canonical package (known fields only, CRLF normalised) or raise ApiError(422)."""
    if not isinstance(raw, dict):
        raise bad("package must be a JSON object")
    pid = raw.get("id")
    if not isinstance(pid, str) or not ID_RE.match(pid):
        raise bad("id must be 2-64 chars: lowercase letters, digits, . _ - (starting with a letter or digit)")
    ver = raw.get("version")
    if not isinstance(ver, str) or not VERSION_RE.match(ver):
        raise bad("version must be semver, e.g. 1.2.0")
    pkg: dict = {"id": pid, "name": _text(raw.get("name"), "name", 200).strip() or pid, "version": ver,
                 "description": _text(raw.get("description"), "description", 4000), "team": _text(raw.get("team"), "team", 200)}
    tags = raw.get("tags") or []
    if not isinstance(tags, list) or len(tags) > 20 or not all(isinstance(t, str) and 0 < len(t) <= 40 for t in tags):
        raise bad("tags must be a list of up to 20 short strings")
    pkg["tags"] = tags
    for key, _, name_re in ITEM_KINDS:
        items = raw.get(key) or []
        if not isinstance(items, list) or len(items) > MAX_ITEMS:
            raise bad(f"{key} must be a list (max {MAX_ITEMS})")
        out, seen = [], set()
        for it in items:
            if not isinstance(it, dict) or not isinstance(it.get("file"), str) or not isinstance(it.get("content"), str):
                raise bad(f"{key}: each item needs file and content strings")
            f = it["file"]
            if not name_re.match(f):
                raise bad(f"{key}: file name not allowed: {f[:80]}")
            if f.lower() in seen:
                raise bad(f"{key}: duplicate file {f}")
            seen.add(f.lower())
            content = it["content"].replace("\r\n", "\n")
            if key == "scripts" and len(content.encode("utf-8")) > MAX_SCRIPT:
                raise bad(f"scripts/{f} is larger than 200 KB")
            if key == "skills":
                meta, body = frontmatter(content)
                cmd = (meta.get("command") or f[:-3]).strip().lower()
                if not COMMAND_RE.match(cmd):
                    raise bad(f'skills/{f}: command "{cmd[:60]}" must be lowercase letters, digits and dashes (set command: or rename the file)')
                if not body.strip():
                    raise bad(f"skills/{f}: the skill body is empty")
            if key == "agents" and not AGENT_HDR.match(content):
                raise bad(f"agents/{f}: needs a --- header with name: (see agents/_template.md)")
            if key == "workflows" and not WORKFLOW_HDR.match(content):
                raise bad(f"workflows/{f}: needs a --- header with command:")
            if key == "workflows" and not frontmatter(content)[1].strip():
                raise bad(f"workflows/{f}: the workflow body is empty")
            out.append({"file": f, "content": content})
        if out:
            pkg[key] = out
    instructions = _text(raw.get("instructions"), "instructions", MAX_PACKAGE)
    if instructions.strip():
        pkg["instructions"] = instructions
    mcp = raw.get("mcpServers") or []
    if not isinstance(mcp, list) or len(mcp) > 50:
        raise bad("mcpServers must be a list")
    servers = []
    for m in mcp:
        if not isinstance(m, dict) or not isinstance(m.get("id"), str) or not ID_RE.match(m["id"]) or not isinstance(m.get("command"), str) or not m["command"].strip():
            raise bad("mcpServers: each server needs an id (like a plugin id) and a command")
        s = {"id": m["id"], "label": _text(m.get("label"), "mcpServers.label", 200) or m["id"], "command": _text(m["command"], "mcpServers.command", 1000)}
        for k in ("args", "env"):
            s[k] = _text(m.get(k), f"mcpServers.{k}", 4000)
        servers.append(s)
    if servers:
        pkg["mcpServers"] = servers
    exam = raw.get("exam")
    if exam is not None:
        if not isinstance(exam, dict):
            raise bad("exam must be an object")
        clean = {}
        for k in EXAM_KEYS:
            v = exam.get(k)
            if k in ("licensePort", "restPort"):
                if isinstance(v, int) and not isinstance(v, bool) and 0 < v < 65536:
                    clean[k] = v
            elif isinstance(v, str) and v.strip() and len(v) <= 1000:
                clean[k] = v.strip()
        if clean:
            pkg["exam"] = clean
    if not kinds(pkg):
        raise bad("the package contains nothing: add at least one agent, workflow, skill, script, instructions, MCP server or EXAM setup")
    if len(package_bytes(pkg)) > MAX_PACKAGE:
        raise ApiError(413, "too_large", "package is larger than 2 MB")
    return pkg


def frontmatter(src: str) -> tuple[dict, str]:
    """Same as src/main/roles.ts parseFrontmatter (flat `key: value` lines)."""
    m = FRONT_RE.match(src)
    if not m:
        return {}, src
    meta = {}
    for line in m.group(1).splitlines():
        kv = re.match(r"^([\w-]+):\s*(.*)$", line.strip())
        if kv:
            meta[kv.group(1)] = kv.group(2).strip()
    return meta, m.group(2)


def kinds(pkg: dict) -> list[str]:
    out = [k for key, k, _ in ITEM_KINDS if pkg.get(key)]
    if (pkg.get("instructions") or "").strip():
        out.append("instructions")
    if pkg.get("mcpServers"):
        out.append("mcp")
    if pkg.get("exam"):
        out.append("exam")
    return out


def package_bytes(pkg: dict) -> bytes:
    """The exact bytes published at marketplace/plugins/<id>-<version>.json (the index sha256 is over these)."""
    return json_bytes(pkg, pretty=True)


def as_files(pkg: dict | None) -> dict[str, str]:
    """Flatten a package to path -> text for review diffs."""
    if not pkg:
        return {}
    meta = {k: pkg.get(k) for k in ("name", "description", "team", "tags")}
    out = {"plugin.json": json.dumps(meta, ensure_ascii=False, indent=2)}
    for key, _, _ in ITEM_KINDS:
        for it in pkg.get(key) or []:
            out[f"{key}/{it['file']}"] = it["content"]
    if (pkg.get("instructions") or "").strip():
        out["instructions.md"] = pkg["instructions"]
    if pkg.get("mcpServers"):
        out["mcp.json"] = json.dumps(pkg["mcpServers"], ensure_ascii=False, indent=2)
    if pkg.get("exam"):
        out["exam.json"] = json.dumps(pkg["exam"], ensure_ascii=False, indent=2)
    return out


def diff(before: dict | None, after: dict) -> list[dict]:
    a, b = as_files(before), as_files(after)
    out = []
    for path in sorted(set(a) | set(b)):
        if path not in a:
            out.append({"path": path, "change": "added", "before": "", "after": b[path]})
        elif path not in b:
            out.append({"path": path, "change": "removed", "before": a[path], "after": ""})
        elif a[path] != b[path]:
            out.append({"path": path, "change": "modified", "before": a[path], "after": b[path]})
    return out


def _read(p: Path) -> str:
    return p.read_text(encoding="utf-8").replace("\r\n", "\n")


def _read_dir(d: Path, name_re) -> list[dict]:
    if not d.is_dir():
        return []
    return [{"file": f.name, "content": _read(f)} for f in sorted(d.iterdir(), key=lambda x: x.name) if f.is_file() and name_re.match(f.name)]


def read_plugin_src(folder: Path, root: Path) -> tuple[dict, list[Path]]:
    """Build a package from plugins-src/<id>/ (layout of scripts/marketplace/build-index.mjs).
    Returns (package, attachment files to copy to marketplace/files). Raises ValueError with all problems."""
    problems: list[str] = []
    try:
        meta = json.loads(_read(folder / "plugin.json"))
    except (OSError, ValueError) as e:
        raise ValueError(f"plugin.json: {e}") from None
    if not isinstance(meta, dict):
        raise ValueError("plugin.json must be an object")
    if meta.get("id") != folder.name:
        problems.append(f'plugin.json id "{meta.get("id")}" must match the folder name "{folder.name}"')
    raw = {k: meta.get(k) for k in ("id", "name", "version", "description", "team", "tags")}
    for key, _, name_re in ITEM_KINDS:
        raw[key] = _read_dir(folder / key, name_re)
    if (folder / "scripts").is_dir():
        problems += [f"scripts/{f.name}: file type not allowed" for f in sorted((folder / "scripts").iterdir()) if not SCRIPT_RE.match(f.name)]
    if (folder / "instructions.md").is_file():
        raw["instructions"] = _read(folder / "instructions.md")
    attachments: list[Path] = []
    for fname, key in (("mcp.json", "mcpServers"), ("exam.json", "exam")):
        if (folder / fname).is_file():
            try:
                raw[key] = json.loads(_read(folder / fname))
            except ValueError as e:
                problems.append(f"{fname}: {e}")
    exam = raw.get("exam")
    if isinstance(exam, dict) and isinstance(exam.get("pluginPackage"), str):
        pp = exam["pluginPackage"].strip()
        if not re.match(r"^(https?:|\\\\|[a-z]:)", pp, re.I):
            rel = pp.lstrip("./").replace("\\", "/")
            parts = rel.split("/")
            src = root / rel
            if len(parts) != 2 or parts[0] != "files" or not NAME_RE.match(parts[1]):
                problems.append(f'exam.json: pluginPackage "{pp}" must be files/<name> (letters, digits, . _ -)')
            elif not src.is_file():
                problems.append(f'exam.json: pluginPackage "{pp}" not found in the marketplace folder')
            else:
                attachments.append(src)
                exam["pluginPackage"] = rel
    try:
        pkg = validate(raw)
    except ApiError as e:
        problems.append(e.message)
        pkg = {}
    if problems:
        raise ValueError("; ".join(problems))
    return pkg, attachments
