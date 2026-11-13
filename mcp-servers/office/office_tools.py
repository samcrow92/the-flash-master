"""PowerPoint tools (python-pptx): outline, create, edit, tables, images, notes, Ishikawa slides.

Token discipline: `pptx_outline` returns titles and short text per slide, and `pptx_slide` returns one slide.
Edits are targeted (by slide index / shape), so agents never round-trip a whole deck.
"""
from __future__ import annotations

import os
from typing import Any

import ishikawa

LAYOUTS = {"title": 0, "title_content": 1, "section": 2, "two_content": 3, "comparison": 4, "title_only": 5, "blank": 6}


def _pptx():
    try:
        import pptx  # noqa: F401
        from pptx import Presentation
    except ImportError as e:
        raise RuntimeError("python-pptx is not installed in the MCP environment") from e
    return Presentation


def _open(path: str, must_exist: bool = True):
    Presentation = _pptx()
    p = os.path.abspath(os.path.expanduser(path))
    if must_exist and not os.path.isfile(p):
        raise FileNotFoundError(f"file not found: {path}")
    return Presentation(p) if os.path.isfile(p) else None, p


def _slide(prs, index: int):
    n = len(prs.slides)
    if not 1 <= index <= n:
        raise IndexError(f"slide {index} out of range (1..{n})")
    return prs.slides[index - 1]


def _texts(slide, max_chars: int = 300) -> dict[str, Any]:
    title = slide.shapes.title.text_frame.text if slide.shapes.title is not None and slide.shapes.title.has_text_frame else ""
    body = []
    for sh in slide.shapes:
        if sh.has_text_frame and sh != slide.shapes.title:
            t = sh.text_frame.text.strip()
            if t:
                body.append(t)
        elif getattr(sh, "has_table", False) and sh.has_table:
            body.append(f"[table {len(sh.table.rows)}x{len(sh.table.columns)}]")
        elif sh.shape_type == 13:
            body.append("[picture]")
    text = " | ".join(body)
    return {"title": title, "text": text[:max_chars] + ("…" if len(text) > max_chars else "")}


def pptx_outline(path: str) -> dict[str, Any]:
    prs, _ = _open(path)
    return {"slides": len(prs.slides), "size": [prs.slide_width, prs.slide_height],
            "outline": [{"n": i + 1, "layout": s.slide_layout.name, **_texts(s, 160)} for i, s in enumerate(prs.slides)]}


def pptx_slide(path: str, index: int) -> dict[str, Any]:
    prs, _ = _open(path)
    s = _slide(prs, index)
    shapes = []
    for i, sh in enumerate(s.shapes):
        item: dict[str, Any] = {"shape": i, "name": sh.name, "type": str(sh.shape_type)}
        if sh.has_text_frame:
            item["paragraphs"] = [p.text for p in sh.text_frame.paragraphs][:30]
        if getattr(sh, "has_table", False) and sh.has_table:
            item["table"] = [[c.text for c in r.cells] for r in list(sh.table.rows)[:20]]
        shapes.append(item)
    notes = s.notes_slide.notes_text_frame.text if s.has_notes_slide else ""
    return {"n": index, "layout": s.slide_layout.name, "shapes": shapes, "notes": notes}


def _fill_bullets(tf, bullets: list[Any]) -> None:
    tf.clear()
    first = True
    for b in bullets:
        level = 0
        if isinstance(b, dict):
            level, b = int(b.get("level", 0)), b.get("text", "")
        p = tf.paragraphs[0] if first else tf.add_paragraph()
        p.text = str(b)
        p.level = max(0, min(level, 4))
        first = False


def _add(prs, spec: dict[str, Any]):
    layout = prs.slide_layouts[LAYOUTS.get(spec.get("layout", "title_content"), 1) if len(prs.slide_layouts) > 6 else 0]
    s = prs.slides.add_slide(layout)
    if s.shapes.title is not None and spec.get("title") is not None:
        s.shapes.title.text = str(spec["title"])
    phs = [p for p in s.placeholders if p.placeholder_format.idx != 0]
    if spec.get("subtitle") and phs:
        phs[0].text = str(spec["subtitle"])
    elif spec.get("bullets") and phs:
        _fill_bullets(phs[0].text_frame, spec["bullets"])
    if spec.get("right_bullets") and len(phs) > 1:
        _fill_bullets(phs[1].text_frame, spec["right_bullets"])
    if spec.get("notes"):
        s.notes_slide.notes_text_frame.text = str(spec["notes"])
    if spec.get("table"):
        _table(s, spec["table"])
    if spec.get("ishikawa"):
        ish = spec["ishikawa"]
        ishikawa.add_to_slide(s, ish.get("problem", ""), ish.get("categories", {}))
    return s


def _table(slide, rows: list[list[Any]]):
    from pptx.util import Emu
    rows = [[str(c) for c in r] for r in rows][:25]
    ncols = max(len(r) for r in rows)
    shape = slide.shapes.add_table(len(rows), ncols, Emu(457200), Emu(1600000), Emu(11277600), Emu(370000 * len(rows)))
    for i, r in enumerate(rows):
        for j in range(ncols):
            shape.table.cell(i, j).text = r[j] if j < len(r) else ""
    return shape


def pptx_create(path: str, slides: list[dict[str, Any]], template: str = "", overwrite: bool = False) -> dict[str, Any]:
    """Create a deck. Each slide: {layout, title, subtitle?, bullets?, right_bullets?, table?, notes?, ishikawa?}."""
    Presentation = _pptx()
    p = os.path.abspath(os.path.expanduser(path))
    if os.path.exists(p) and not overwrite:
        raise FileExistsError(f"{path} exists — pass overwrite=true or use pptx_edit")
    if template:
        prs = Presentation(os.path.abspath(os.path.expanduser(template)))
        for sld_id in list(prs.slides._sldIdLst):  # keep masters/theme, drop template content
            prs.part.drop_rel(sld_id.rId)
            prs.slides._sldIdLst.remove(sld_id)
    else:
        from pptx.util import Emu
        prs = Presentation()
        prs.slide_width, prs.slide_height = Emu(12192000), Emu(6858000)
    for spec in slides:
        _add(prs, spec)
    os.makedirs(os.path.dirname(p) or ".", exist_ok=True)
    prs.save(p)
    return {"saved": p, "slides": len(prs.slides)}


def pptx_edit(path: str, operations: list[dict[str, Any]]) -> dict[str, Any]:
    """Apply targeted edits in order. ops:
    {op:"add_slide", spec:{…}, position?:n} · {op:"delete_slide", index} · {op:"move_slide", index, to}
    {op:"set_title", index, text} · {op:"set_bullets", index, bullets, placeholder?:1}
    {op:"replace_text", find, replace, index?} · {op:"set_notes", index, text}
    {op:"add_table", index, rows} · {op:"add_image", index, image, left_cm?, top_cm?, width_cm?}
    {op:"add_ishikawa", index?, problem, categories}  (index omitted = new slide)"""
    prs, p = _open(path)
    done = []
    for o in operations:
        op = o.get("op")
        if op == "add_slide":
            _add(prs, o.get("spec", {}))
            if o.get("position"):
                _move(prs, len(prs.slides), int(o["position"]))
        elif op == "delete_slide":
            sid = prs.slides._sldIdLst[int(o["index"]) - 1]
            prs.part.drop_rel(sid.rId)
            prs.slides._sldIdLst.remove(sid)
        elif op == "move_slide":
            _move(prs, int(o["index"]), int(o["to"]))
        elif op == "set_title":
            s = _slide(prs, int(o["index"]))
            if s.shapes.title is None:
                raise ValueError(f"slide {o['index']} has no title placeholder")
            s.shapes.title.text = str(o["text"])
        elif op == "set_bullets":
            s = _slide(prs, int(o["index"]))
            phs = [x for x in s.placeholders if x.placeholder_format.idx != 0]
            k = int(o.get("placeholder", 1)) - 1
            if k >= len(phs):
                raise ValueError("no body placeholder on that slide")
            _fill_bullets(phs[k].text_frame, o.get("bullets", []))
        elif op == "replace_text":
            n = 0
            targets = [_slide(prs, int(o["index"]))] if o.get("index") else list(prs.slides)
            for s in targets:
                for sh in s.shapes:
                    if sh.has_text_frame:
                        for para in sh.text_frame.paragraphs:
                            for run in para.runs:
                                if o["find"] in run.text:
                                    run.text = run.text.replace(o["find"], o.get("replace", ""))
                                    n += 1
            done.append(f"replace_text: {n} runs")
            continue
        elif op == "set_notes":
            _slide(prs, int(o["index"])).notes_slide.notes_text_frame.text = str(o.get("text", ""))
        elif op == "add_table":
            _table(_slide(prs, int(o["index"])), o["rows"])
        elif op == "add_image":
            from pptx.util import Cm
            s = _slide(prs, int(o["index"]))
            img = os.path.abspath(os.path.expanduser(o["image"]))
            s.shapes.add_picture(img, Cm(o.get("left_cm", 2)), Cm(o.get("top_cm", 4)), width=Cm(o["width_cm"]) if o.get("width_cm") else None)
        elif op == "add_ishikawa":
            if o.get("index"):
                s = _slide(prs, int(o["index"]))
            else:
                s = _add(prs, {"layout": "title_only", "title": o.get("title", "Root cause analysis (Ishikawa)")})
            ishikawa.add_to_slide(s, o.get("problem", ""), o.get("categories", {}))
        else:
            raise ValueError(f"unknown op {op}")
        done.append(op)
    prs.save(p)
    return {"saved": p, "slides": len(prs.slides), "applied": done}


def _move(prs, index: int, to: int) -> None:
    lst = prs.slides._sldIdLst
    el = lst[index - 1]
    lst.remove(el)
    lst.insert(max(0, min(to - 1, len(lst))), el)


def ishikawa_svg(path: str, problem: str, categories: Any) -> dict[str, Any]:
    p = os.path.abspath(os.path.expanduser(path))
    os.makedirs(os.path.dirname(p) or ".", exist_ok=True)
    with open(p, "w", encoding="utf-8") as f:
        f.write(ishikawa.svg(problem, categories))
    return {"saved": p}
