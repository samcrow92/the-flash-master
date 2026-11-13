"""office MCP server: create and edit PowerPoint decks; render Ishikawa (fishbone) diagrams."""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from mcp_stdio import McpServer  # noqa: E402
import office_tools as ot  # noqa: E402

S = McpServer("office")
P = {"type": "string", "description": "absolute .pptx path"}
CATS = {"description": 'categories: {"Requirements": ["cause", …], …} or [{"name", "causes"}]'}


def schema(props: dict, required: list[str]) -> dict:
    return {"type": "object", "properties": props, "required": required}


@S.tool("Deck outline: slide count and title + short text per slide. Start here before editing.", schema({"path": P}, ["path"]))
def pptx_outline(path): return ot.pptx_outline(path)


@S.tool("One slide in detail: shapes, paragraphs, tables, notes.", schema({"path": P, "index": {"type": "integer"}}, ["path", "index"]))
def pptx_slide(path, index): return ot.pptx_slide(path, index)


@S.tool("Create a deck (16:9, or from a corporate .potx/.pptx template). slides: [{layout: title|title_content|section|two_content|comparison|title_only|blank, "
        "title, subtitle, bullets: [str | {text, level}], right_bullets, table: [[…]], notes, ishikawa: {problem, categories}}].",
        schema({"path": P, "slides": {"type": "array", "items": {"type": "object"}}, "template": {"type": "string"}, "overwrite": {"type": "boolean"}}, ["path", "slides"]))
def pptx_create(path, slides, template="", overwrite=False): return ot.pptx_create(path, slides, template, overwrite)


@S.tool("Targeted edits on an existing deck (add/delete/move slides, set title/bullets/notes, replace text, add table/image/Ishikawa). "
        "ops: add_slide{spec,position} delete_slide{index} move_slide{index,to} set_title{index,text} set_bullets{index,bullets,placeholder} "
        "replace_text{find,replace,index?} set_notes{index,text} add_table{index,rows} add_image{index,image,left_cm,top_cm,width_cm} add_ishikawa{index?,problem,categories,title}",
        schema({"path": P, "operations": {"type": "array", "items": {"type": "object"}}}, ["path", "operations"]))
def pptx_edit(path, operations): return ot.pptx_edit(path, operations)


@S.tool("Render an Ishikawa (fishbone) diagram to an SVG file.",
        schema({"path": {"type": "string"}, "problem": {"type": "string"}, "categories": CATS}, ["path", "problem", "categories"]))
def ishikawa_svg(path, problem, categories): return ot.ishikawa_svg(path, problem, categories)


if __name__ == "__main__":
    S.run()
