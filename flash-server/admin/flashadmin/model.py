"""Plain helpers over API data: package → files, unified diffs, labels."""
from __future__ import annotations

import difflib
import json
from typing import List, Optional, Tuple

STATUS_LABELS = {
    "pending": "Pending", "approved": "Approved", "rejected": "Rejected",
    "changes_requested": "Changes requested", "withdrawn": "Withdrawn",
}


def package_files(pkg: Optional[dict]) -> List[Tuple[str, str]]:
    """Flatten a PluginPackage into (path, content) pairs, the same paths the server diff uses."""
    if not pkg:
        return []
    out: List[Tuple[str, str]] = []
    for group in ("agents", "workflows", "skills", "scripts"):
        for item in pkg.get(group) or []:
            out.append((f"{group}/{item.get('file', '?')}", item.get("content", "")))
    if pkg.get("instructions"):
        out.append(("instructions.md", pkg["instructions"]))
    if pkg.get("mcpServers"):
        out.append(("mcpServers.json", json.dumps(pkg["mcpServers"], indent=2)))
    if pkg.get("exam"):
        out.append(("exam.json", json.dumps(pkg["exam"], indent=2)))
    return out


def unified(before: str, after: str, path: str = "", context: int = 3) -> List[str]:
    return list(difflib.unified_diff((before or "").splitlines(), (after or "").splitlines(),
                                     fromfile=f"a/{path}", tofile=f"b/{path}", lineterm="", n=context))


def diff_stats(files: List[dict]) -> Tuple[int, int]:
    add = rem = 0
    for f in files:
        for line in unified(f.get("before") or "", f.get("after") or "")[2:]:
            if line.startswith("+"):
                add += 1
            elif line.startswith("-"):
                rem += 1
    return add, rem


def sort_submissions(subs: List[dict]) -> List[dict]:
    """Pending first, then newest first."""
    return sorted(subs, key=lambda s: (s.get("status") != "pending", _neg(s.get("createdAt") or "")))


def _neg(s: str) -> Tuple[int, ...]:
    return tuple(-ord(c) for c in s)


def user_note(server_url: str, token: str, name: str = "") -> str:
    hello = f"Hi {name}, here" if name else "Here"
    return (f"{hello} is your access to the Flash Server.\n\n"
            f"Server URL: {server_url}\n"
            f"Token: {token}\n\n"
            "In TheFlashMaster open Settings → Server, paste the URL and the token, and press Save.\n"
            "Keep the token private; ask for a new one if it leaks.")
