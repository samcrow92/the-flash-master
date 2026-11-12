"""Token-efficient query tools for automotive artefacts: DBC, ARXML, CDD (CANdela) and CAPL.

Each function answers a targeted question and returns compact JSON-able data. None of them dumps whole files.
Parsers are dependency-free (stdlib) so they work in locked-down environments. `cantools` is used only for
signal decoding when it is installed.
"""
from __future__ import annotations

import os
import re
import xml.etree.ElementTree as ET
from functools import lru_cache
from typing import Any

MAX_ITEMS = 60


def _check(path: str) -> str:
    p = os.path.abspath(os.path.expanduser(path))
    if not os.path.isfile(p):
        raise FileNotFoundError(f"file not found: {path}")
    return p


def _mtime(p: str) -> float:
    return os.path.getmtime(p)


# =====================================================================  DBC

_BO = re.compile(r"^BO_\s+(\d+)\s+(\w+)\s*:\s*(\d+)\s+(\w+)")
_SG = re.compile(
    r"^\s*SG_\s+(\w+)\s*(M|m\d+M?)?\s*:\s*(\d+)\|(\d+)@([01])([+-])\s*\(([^,]+),([^)]+)\)\s*\[([^|]*)\|([^\]]*)\]\s*\"([^\"]*)\"\s*(.*)$"
)
_CYCLE = re.compile(r'^BA_\s+"GenMsgCycleTime"\s+BO_\s+(\d+)\s+(\d+)\s*;')
_CM_BO = re.compile(r'CM_\s+BO_\s+(\d+)\s+"((?:[^"\\]|\\.)*)"\s*;', re.S)
_CM_SG = re.compile(r'CM_\s+SG_\s+(\d+)\s+(\w+)\s+"((?:[^"\\]|\\.)*)"\s*;', re.S)
_VAL = re.compile(r"^VAL_\s+(\d+)\s+(\w+)\s+(.*);")


@lru_cache(maxsize=8)
def _parse_dbc(p: str, _mt: float) -> dict[str, Any]:
    with open(p, encoding="latin-1") as f:
        text = f.read()
    nodes: list[str] = []
    msgs: dict[int, dict[str, Any]] = {}
    cur: dict[str, Any] | None = None
    version = ""
    for raw in text.splitlines():
        line = raw.rstrip()
        if line.startswith("VERSION"):
            version = line.split('"')[1] if '"' in line else ""
        elif line.startswith("BU_"):
            nodes = line.split(":", 1)[1].split() if ":" in line else []
        elif m := _BO.match(line):
            fid = int(m.group(1))
            cur = {"id": fid & 0x1FFFFFFF, "extended": bool(fid & 0x80000000), "name": m.group(2), "dlc": int(m.group(3)),
                   "sender": m.group(4), "signals": [], "cycle_ms": None, "comment": None, "_raw": fid}
            msgs[fid] = cur
        elif (m := _SG.match(line)) and cur is not None:
            cur["signals"].append({
                "name": m.group(1), "mux": m.group(2), "start": int(m.group(3)), "length": int(m.group(4)),
                "byte_order": "little_endian" if m.group(5) == "1" else "big_endian", "signed": m.group(6) == "-",
                "factor": float(m.group(7)), "offset": float(m.group(8)),
                "min": _num(m.group(9)), "max": _num(m.group(10)), "unit": m.group(11),
                "receivers": [r for r in m.group(12).replace(",", " ").split() if r and r != "Vector__XXX"],
            })
        elif not line.strip():
            cur = None
    for line in text.splitlines():
        if m := _CYCLE.match(line.strip()):
            if int(m.group(1)) in msgs:
                msgs[int(m.group(1))]["cycle_ms"] = int(m.group(2))
        elif m := _VAL.match(line.strip()):
            msg = msgs.get(int(m.group(1)))
            if msg:
                for s in msg["signals"]:
                    if s["name"] == m.group(2):
                        pairs = re.findall(r'(-?\d+)\s+"([^"]*)"', m.group(3))
                        s["choices"] = {int(k): v for k, v in pairs}
    for m in _CM_BO.finditer(text):
        if int(m.group(1)) in msgs:
            msgs[int(m.group(1))]["comment"] = m.group(2)[:300]
    for m in _CM_SG.finditer(text):
        for s in msgs.get(int(m.group(1)), {}).get("signals", []):
            if s["name"] == m.group(2):
                s["comment"] = m.group(3)[:300]
    return {"version": version, "nodes": nodes, "messages": msgs}


def _num(s: str) -> float | None:
    try:
        return float(s)
    except ValueError:
        return None


def _resolve_message(db: dict[str, Any], name_or_id: str) -> dict[str, Any]:
    key = str(name_or_id).strip()
    for m in db["messages"].values():
        if m["name"].lower() == key.lower():
            return m
    try:
        n = int(key, 16) if key.lower().startswith("0x") else int(key)
        for m in db["messages"].values():
            if m["id"] == n or m["_raw"] == n:
                return m
    except ValueError:
        pass
    raise KeyError(f"message '{name_or_id}' not found")


def dbc_summary(path: str) -> dict[str, Any]:
    db = _parse_dbc(_check(path), _mtime(_check(path)))
    msgs = list(db["messages"].values())
    by_sender: dict[str, int] = {}
    for m in msgs:
        by_sender[m["sender"]] = by_sender.get(m["sender"], 0) + 1
    return {"version": db["version"], "nodes": db["nodes"], "messages": len(msgs),
            "signals": sum(len(m["signals"]) for m in msgs), "messages_by_sender": by_sender,
            "extended_ids": sum(1 for m in msgs if m["extended"])}


def dbc_find(path: str, pattern: str, kind: str = "any") -> list[dict[str, Any]]:
    db = _parse_dbc(_check(path), _mtime(_check(path)))
    rx = re.compile(pattern, re.I)
    out: list[dict[str, Any]] = []
    for m in db["messages"].values():
        if kind in ("any", "message") and rx.search(m["name"]):
            out.append({"message": m["name"], "id": hex(m["id"]), "sender": m["sender"]})
        if kind in ("any", "signal"):
            for s in m["signals"]:
                if rx.search(s["name"]):
                    out.append({"signal": s["name"], "message": m["name"], "id": hex(m["id"]), "unit": s["unit"]})
        if len(out) >= MAX_ITEMS:
            out.append({"note": f"truncated at {MAX_ITEMS} results — refine the pattern"})
            break
    return out


def dbc_message(path: str, message: str) -> dict[str, Any]:
    db = _parse_dbc(_check(path), _mtime(_check(path)))
    m = dict(_resolve_message(db, message))
    m.pop("_raw", None)
    m["id"] = hex(m["id"])
    return m


def dbc_decode(path: str, message: str, data_hex: str) -> dict[str, Any]:
    """Decode a raw frame payload. Uses cantools when available (handles multiplexing and big-endian correctly)."""
    p = _check(path)
    try:
        import cantools  # type: ignore
    except ImportError as e:
        raise RuntimeError("cantools is not installed in the MCP environment") from e
    dbm = cantools.database.load_file(p, strict=False)
    msg = _resolve_message(_parse_dbc(p, _mtime(p)), message)
    data = bytes.fromhex(data_hex.replace(" ", ""))
    return {k: (v if isinstance(v, (int, float)) else str(v)) for k, v in dbm.get_message_by_name(msg["name"]).decode(data).items()}


# =====================================================================  ARXML

def _strip(tag: str) -> str:
    return tag.split("}", 1)[1] if "}" in tag else tag


@lru_cache(maxsize=4)
def _parse_arxml(p: str, _mt: float) -> tuple[ET.Element, dict[str, ET.Element], str]:
    tree = ET.parse(p)
    root = tree.getroot()
    for el in root.iter():
        el.tag = _strip(el.tag)
    index: dict[str, ET.Element] = {}

    def walk(el: ET.Element, prefix: str) -> None:
        sn = el.find("SHORT-NAME")
        path = prefix
        if sn is not None and sn.text:
            path = f"{prefix}/{sn.text.strip()}"
            index[path] = el
        for child in el:
            if child.tag != "SHORT-NAME":
                walk(child, path)

    walk(root, "")
    schema = root.attrib.get("{http://www.w3.org/2001/XMLSchema-instance}schemaLocation", "")
    return root, index, schema


def arxml_summary(path: str, depth: int = 2) -> dict[str, Any]:
    p = _check(path)
    _root, index, schema = _parse_arxml(p, _mtime(p))
    counts: dict[str, int] = {}
    for el in index.values():
        counts[el.tag] = counts.get(el.tag, 0) + 1
    packages = sorted({"/".join(k.split("/")[: depth + 1]) for k, v in index.items() if v.tag == "AR-PACKAGE" and k.count("/") <= depth})
    top = dict(sorted(counts.items(), key=lambda kv: -kv[1])[:25])
    return {"schema": schema.split()[-1] if schema else "", "elements": len(index), "packages": packages[:MAX_ITEMS], "types": top}


def arxml_find(path: str, name: str = "", type: str = "", limit: int = 40) -> list[dict[str, str]]:
    p = _check(path)
    _root, index, _ = _parse_arxml(p, _mtime(p))
    rx = re.compile(name, re.I) if name else None
    out = []
    for k, el in index.items():
        if type and el.tag.upper() != type.upper():
            continue
        if rx and not rx.search(k.rsplit("/", 1)[-1]):
            continue
        out.append({"path": k, "type": el.tag})
        if len(out) >= min(limit, MAX_ITEMS):
            out.append({"path": "…", "type": "truncated — refine name/type"})
            break
    return out


def _compact(el: ET.Element, depth: int) -> Any:
    children = [c for c in el if c.tag != "SHORT-NAME"]
    text = (el.text or "").strip()
    if not children:
        return text if not el.attrib else {"_": text, **el.attrib}
    if depth <= 0:
        sn = el.find("SHORT-NAME")
        return f"<{len(children)} children>" + (f" {sn.text}" if sn is not None and sn.text else "")
    out: dict[str, Any] = {}
    sn = el.find("SHORT-NAME")
    if sn is not None and sn.text:
        out["SHORT-NAME"] = sn.text
    for c in children:
        v = _compact(c, depth - 1)
        if c.tag in out:
            if not isinstance(out[c.tag], list):
                out[c.tag] = [out[c.tag]]
            if len(out[c.tag]) < 30:
                out[c.tag].append(v)
        else:
            out[c.tag] = v
    return out


def arxml_element(path: str, element: str, depth: int = 2) -> dict[str, Any]:
    p = _check(path)
    _root, index, _ = _parse_arxml(p, _mtime(p))
    el = index.get(element)
    if el is None:
        raise KeyError(f"element {element} not found — use arxml_find")
    return {"path": element, "type": el.tag, "content": _compact(el, max(0, min(depth, 5)))}


def arxml_refs(path: str, element: str) -> list[dict[str, str]]:
    p = _check(path)
    root, index, _ = _parse_arxml(p, _mtime(p))
    owner: dict[int, str] = {}
    for k, el in index.items():
        for d in el.iter():
            owner[id(d)] = k  # index is pre-order, so deeper elements overwrite: innermost owner wins
    out = []
    for el in root.iter():
        if el.tag.endswith("REF") and (el.text or "").strip() == element:
            out.append({"from": owner.get(id(el), "?"), "ref": el.tag, "dest": el.attrib.get("DEST", "")})
            if len(out) >= MAX_ITEMS:
                break
    return out


# =====================================================================  CDD (CANdela)

def _tuv(el: ET.Element | None) -> str:
    if el is None:
        return ""
    t = el.find(".//TUV")
    return (t.text or "").strip() if t is not None and t.text else (el.text or "").strip()


@lru_cache(maxsize=4)
def _parse_cdd(p: str, _mt: float) -> ET.Element:
    root = ET.parse(p).getroot()
    for el in root.iter():
        el.tag = _strip(el.tag)
    return root


def cdd_summary(path: str) -> dict[str, Any]:
    p = _check(path)
    root = _parse_cdd(p, _mtime(p))
    ecu = root.find(".//ECU")
    classes = root.findall(".//DIAGCLASS")
    return {
        "ecu": _tuv(ecu.find("NAME")) if ecu is not None else "",
        "diag_classes": [{"qual": c.attrib.get("qual", ""), "name": _tuv(c.find("NAME")), "instances": len(c.findall("DIAGINST"))} for c in classes][:MAX_ITEMS],
        "dtcs": len(root.findall(".//DTC")),
        "variants": [v.attrib.get("qual", _tuv(v.find("NAME"))) for v in root.findall(".//VAR")][:20],
    }


def cdd_services(path: str, filter: str = "") -> list[dict[str, str]]:
    p = _check(path)
    root = _parse_cdd(p, _mtime(p))
    rx = re.compile(filter, re.I) if filter else None
    out = []
    for c in root.findall(".//DIAGCLASS"):
        cname = _tuv(c.find("NAME"))
        for i in c.findall("DIAGINST"):
            name = _tuv(i.find("NAME"))
            qual = i.attrib.get("qual", "")
            if rx and not (rx.search(name) or rx.search(qual) or rx.search(cname)):
                continue
            out.append({"class": cname, "name": name, "qual": qual, "id": i.attrib.get("id", "")})
            if len(out) >= MAX_ITEMS:
                return out + [{"class": "…", "name": "truncated — use a filter", "qual": "", "id": ""}]
    return out


# =====================================================================  CAPL

_CAPL_HANDLER = re.compile(r"^\s*on\s+(message|signal|timer|msTimer|key|start|preStart|stopMeasurement|envVar|sysvar|sysvar_update|errorFrame|busOff|diagRequest|diagResponse)\b\s*([^{\n]*)", re.M | re.I)
_CAPL_FUNC = re.compile(r"^\s*(?:export\s+)?(?:testcase|testfunction|void|int|long|dword|word|byte|char|float|double|int64|qword)\s+(\w+)\s*\(([^)]*)\)\s*\{?", re.M)
_CAPL_INCLUDE = re.compile(r'#include\s+"([^"]+)"')


def _read(p: str) -> str:
    with open(p, encoding="utf-8", errors="replace") as f:
        return f.read()


def _strip_comments(src: str) -> str:
    src = re.sub(r"/\*.*?\*/", lambda m: "\n" * m.group(0).count("\n"), src, flags=re.S)
    return re.sub(r"//[^\n]*", "", src)


def capl_index(path: str) -> dict[str, Any]:
    p = _check(path)
    src = _strip_comments(_read(p))
    var_block = re.search(r"variables\s*\{(.*?)\n\}", src, re.S)
    variables = []
    if var_block:
        for line in var_block.group(1).splitlines():
            line = line.strip().rstrip(";")
            if line and not line.startswith("#"):
                variables.append(line[:120])
    return {
        "includes": _CAPL_INCLUDE.findall(src),
        "variables": variables[:MAX_ITEMS],
        "handlers": [f"on {m.group(1)} {m.group(2).strip()}".strip() for m in _CAPL_HANDLER.finditer(src)][:MAX_ITEMS],
        "functions": [f"{m.group(1)}({m.group(2).strip()})" for m in _CAPL_FUNC.finditer(src)][:MAX_ITEMS],
        "lines": src.count("\n") + 1,
    }


def capl_lint(path: str) -> list[str]:
    p = _check(path)
    raw = _read(p)
    src = _strip_comments(raw)
    src_nostr = re.sub(r'"(?:[^"\\]|\\.)*"', '""', src)
    issues: list[str] = []
    for open_c, close_c, label in (("{", "}", "braces"), ("(", ")", "parentheses"), ("[", "]", "brackets")):
        if src_nostr.count(open_c) != src_nostr.count(close_c):
            issues.append(f"unbalanced {label}: {src_nostr.count(open_c)} '{open_c}' vs {src_nostr.count(close_c)} '{close_c}'")
    idx = capl_index(path)
    timers = {re.split(r"\s+", v)[-1] for v in idx["variables"] if re.match(r"(ms)?[Tt]imer\s", v)}
    handled = {h.split()[-1] for h in idx["handlers"] if re.match(r"on (ms)?timer", h, re.I)}
    for t in timers:
        if not re.search(rf"\bsetTimer\s*\(\s*{re.escape(t)}\b", src):
            issues.append(f"timer '{t}' is declared but never started with setTimer")
        if t not in handled:
            issues.append(f"timer '{t}' has no 'on timer {t}' handler")
    for h in handled - timers:
        issues.append(f"handler 'on timer {h}' but no timer variable '{h}' declared")
    names = [f.split("(")[0] for f in idx["functions"]]
    for n in sorted({n for n in names if names.count(n) > 1}):
        issues.append(f"function '{n}' defined more than once (overloads must differ in parameters)")
    base = os.path.dirname(p)
    inc_paths = [base] + [x for x in os.environ.get("CAPL_INCLUDE", "").split(";") if x]
    for inc in idx["includes"]:
        if not any(os.path.isfile(os.path.join(d, inc)) for d in inc_paths):
            issues.append(f"include not found: {inc}")
    for i, line in enumerate(raw.splitlines(), 1):
        if re.search(r"\boutput\s*\(\s*\)", line):
            issues.append(f"line {i}: output() called without a message")
    return issues or ["no issues found"]
