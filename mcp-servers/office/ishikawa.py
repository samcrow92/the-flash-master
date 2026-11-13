"""Ishikawa (fishbone) diagram rendering: standalone SVG and native PowerPoint shapes."""
from __future__ import annotations

from typing import Any
from xml.sax.saxutils import escape

DEFAULT_CATEGORIES = ["Requirements", "Design / Architecture", "Implementation", "Verification & Validation",
                      "Process", "People / Organisation", "Tools & Environment", "Interfaces / Suppliers"]


def normalise(categories: Any) -> list[tuple[str, list[str]]]:
    """Accept {"Cat": ["cause", ...]} or [{"name": "Cat", "causes": [...]}]."""
    if isinstance(categories, dict):
        items = list(categories.items())
    else:
        items = [(c.get("name", "?"), c.get("causes", [])) for c in categories or []]
    out = []
    for name, causes in items:
        cs = [str(c) for c in (causes or []) if str(c).strip()][:6]
        out.append((str(name)[:40], cs))
    if not out:
        raise ValueError("at least one category is required")
    return out[:8]


def svg(problem: str, categories: Any, width: int = 1400) -> str:
    cats = normalise(categories)
    top = cats[0::2]
    bottom = cats[1::2]
    cols = max(len(top), len(bottom), 1)
    head_w = 230
    spine_y = 300
    height = 600
    x0, x1 = 240, width - head_w - 20  # x0 leaves room for left-most cause labels
    step = (x1 - x0) / cols
    parts = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" font-family="Segoe UI, Arial, sans-serif" font-size="13">',
             '<rect width="100%" height="100%" fill="#ffffff"/>',
             f'<line x1="{x0}" y1="{spine_y}" x2="{x1}" y2="{spine_y}" stroke="#1f2937" stroke-width="4"/>',
             f'<polygon points="{x1},{spine_y - 12} {x1 + 18},{spine_y} {x1},{spine_y + 12}" fill="#1f2937"/>',
             f'<rect x="{x1 + 20}" y="{spine_y - 60}" width="{head_w - 10}" height="120" rx="10" fill="#fff4cc" stroke="#d97706" stroke-width="2"/>']
    parts += _wrap_text(problem, x1 + 20 + (head_w - 10) / 2, spine_y, 26, weight="600", anchor="middle")
    for row, sign in ((top, -1), (bottom, 1)):
        for i, (name, causes) in enumerate(row):
            bx = x0 + step * (i + 0.85)
            tip_x, tip_y = bx - 90, spine_y + sign * 230
            parts.append(f'<line x1="{bx}" y1="{spine_y}" x2="{tip_x}" y2="{tip_y}" stroke="#374151" stroke-width="2.5"/>')
            ty = tip_y + (-12 if sign < 0 else 22)
            parts.append(f'<text x="{tip_x}" y="{ty}" text-anchor="middle" font-weight="700" fill="#1d4ed8">{escape(name)}</text>')
            for j, c in enumerate(causes):
                t = (j + 1) / (len(causes) + 1)
                cx = bx + (tip_x - bx) * t
                cy = spine_y + (tip_y - spine_y) * t
                parts.append(f'<line x1="{cx}" y1="{cy}" x2="{cx - 70}" y2="{cy}" stroke="#9ca3af" stroke-width="1.5"/>')
                parts.append(f'<text x="{cx - 74}" y="{cy + 4}" text-anchor="end" fill="#111827">{escape(c[:48])}</text>')
    parts.append("</svg>")
    return "".join(parts)


def _wrap_text(text: str, x: float, cy: float, width_chars: int, weight: str = "400", anchor: str = "start") -> list[str]:
    words, lines, cur = str(text).split(), [], ""
    for w in words:
        if len(cur) + len(w) + 1 > width_chars and cur:
            lines.append(cur)
            cur = w
        else:
            cur = f"{cur} {w}".strip()
    if cur:
        lines.append(cur)
    lines = lines[:5]
    y0 = cy - (len(lines) - 1) * 9
    return [f'<text x="{x}" y="{y0 + i * 18 + 4}" text-anchor="{anchor}" font-weight="{weight}">{escape(l)}</text>' for i, l in enumerate(lines)]


def add_to_slide(slide, problem: str, categories: Any) -> None:
    """Draw the fishbone with native, editable PowerPoint shapes (lines + text boxes)."""
    from pptx.dml.color import RGBColor
    from pptx.enum.shapes import MSO_CONNECTOR, MSO_SHAPE
    from pptx.util import Emu, Pt

    cats = normalise(categories)
    W, H = 12192000, 6858000  # 16:9 slide
    spine_y = int(H * 0.55)
    x0, x1 = int(W * 0.04), int(W * 0.76)
    head_w = int(W * 0.21)

    def line(xa, ya, xb, yb, color="1F2937", width=2.5):
        ln = slide.shapes.add_connector(MSO_CONNECTOR.STRAIGHT, Emu(int(xa)), Emu(int(ya)), Emu(int(xb)), Emu(int(yb)))
        ln.line.color.rgb = RGBColor.from_string(color)
        ln.line.width = Pt(width)

    def text(x, y, w, h, s, size=11, bold=False, color="111827", align=None):
        tb = slide.shapes.add_textbox(Emu(int(x)), Emu(int(y)), Emu(int(w)), Emu(int(h)))
        tf = tb.text_frame
        tf.word_wrap = True
        p = tf.paragraphs[0]
        p.text = s
        p.font.size = Pt(size)
        p.font.bold = bold
        p.font.color.rgb = RGBColor.from_string(color)
        if align is not None:
            p.alignment = align

    from pptx.enum.text import PP_ALIGN
    line(x0, spine_y, x1, spine_y, width=4)
    head = slide.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, Emu(x1 + 60000), Emu(spine_y - 520000), Emu(head_w), Emu(1040000))
    head.fill.solid()
    head.fill.fore_color.rgb = RGBColor.from_string("FFF4CC")
    head.line.color.rgb = RGBColor.from_string("D97706")
    head.text_frame.word_wrap = True
    head.text_frame.paragraphs[0].text = problem
    head.text_frame.paragraphs[0].font.size = Pt(13)
    head.text_frame.paragraphs[0].font.bold = True
    head.text_frame.paragraphs[0].font.color.rgb = RGBColor.from_string("111827")
    top, bottom = cats[0::2], cats[1::2]
    cols = max(len(top), len(bottom), 1)
    step = (x1 - x0) / cols
    for row, sign in ((top, -1), (bottom, 1)):
        for i, (name, causes) in enumerate(row):
            bx = x0 + step * (i + 0.85)
            tip_x, tip_y = bx - step * 0.45, spine_y + sign * int(H * 0.33)
            line(bx, spine_y, tip_x, tip_y, color="374151", width=2)
            ty = tip_y - 330000 if sign < 0 else tip_y + 30000
            text(tip_x - 900000, ty, 1800000, 300000, name, size=12, bold=True, color="1D4ED8", align=PP_ALIGN.CENTER)
            for j, c in enumerate(causes):
                t = (j + 1) / (len(causes) + 1)
                cx = bx + (tip_x - bx) * t
                cy = spine_y + (tip_y - spine_y) * t
                line(cx - 500000, cy, cx, cy, color="9CA3AF", width=1)
                text(cx - 2300000, cy - 150000, 1800000, 300000, c[:60], size=9, align=PP_ALIGN.RIGHT)
