import json
import os
import subprocess
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "..", "pycommon"))

pptx = pytest.importorskip("pptx")
import office_tools as ot  # noqa: E402
import ishikawa  # noqa: E402

CATS = {"Requirements": ["Timing requirement ambiguous", "No debounce spec"], "Design / Architecture": ["Shared PWM timer"],
        "Verification & Validation": ["HIL test misses cold start"], "Tools & Environment": []}


def test_create_outline_edit(tmp_path):
    p = str(tmp_path / "deck.pptx")
    r = ot.pptx_create(p, [
        {"layout": "title", "title": "Brake light RCA", "subtitle": "8D – D4"},
        {"layout": "title_content", "title": "Now", "bullets": ["Flicker at cold start", {"text": "-20 °C", "level": 1}], "notes": "speaker"},
        {"layout": "title_only", "title": "Fishbone", "ishikawa": {"problem": "Brake light flickers", "categories": CATS}},
    ])
    assert r["slides"] == 3
    o = ot.pptx_outline(p)
    assert [s["title"] for s in o["outline"]] == ["Brake light RCA", "Now", "Fishbone"]
    assert "Flicker at cold start" in o["outline"][1]["text"]
    ot.pptx_edit(p, [
        {"op": "set_title", "index": 2, "text": "Now (current situation)"},
        {"op": "replace_text", "find": "Flicker", "replace": "Flickering"},
        {"op": "add_slide", "spec": {"title": "Way forward", "bullets": ["Add debounce requirement"]}, "position": 3},
        {"op": "add_table", "index": 3, "rows": [["Action", "Owner"], ["Debounce", "SW"]]},
        {"op": "move_slide", "index": 1, "to": 4},
        {"op": "delete_slide", "index": 4},
    ])
    o = ot.pptx_outline(p)
    assert [s["title"] for s in o["outline"]] == ["Now (current situation)", "Way forward", "Fishbone"]
    assert "Flickering" in o["outline"][0]["text"]
    d = ot.pptx_slide(p, 1)
    assert d["notes"] == "speaker"
    assert any(s.get("table") == [["Action", "Owner"], ["Debounce", "SW"]] for s in ot.pptx_slide(p, 2)["shapes"])
    fish = ot.pptx_slide(p, 3)["shapes"]
    assert sum(1 for s in fish if s.get("paragraphs") == ["Brake light flickers"]) == 1
    with pytest.raises(FileExistsError):
        ot.pptx_create(p, [])


def test_ishikawa_svg(tmp_path):
    s = ishikawa.svg("Brake light <flickers>", CATS)
    assert s.startswith("<svg") and "&lt;flickers&gt;" in s and "Shared PWM timer" in s
    out = ot.ishikawa_svg(str(tmp_path / "f.svg"), "P", [{"name": "Process", "causes": ["x"]}])
    assert os.path.getsize(out["saved"]) > 200


def test_server_lists_tools():
    env = {**os.environ, "PYTHONPATH": os.path.join(ROOT, "..", "pycommon")}
    msgs = [{"jsonrpc": "2.0", "id": 1, "method": "tools/list"}]
    p = subprocess.run([sys.executable, os.path.join(ROOT, "server.py")], input=json.dumps(msgs[0]) + "\n", capture_output=True, text=True, env=env, timeout=30)
    names = {t["name"] for t in json.loads(p.stdout.splitlines()[0])["result"]["tools"]}
    assert names == {"pptx_outline", "pptx_slide", "pptx_create", "pptx_edit", "ishikawa_svg"}
