import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "..", "pycommon"))

import vector_tools as vt  # noqa: E402

F = lambda n: os.path.join(HERE, "fixtures", n)  # noqa: E731


def test_dbc_summary_and_message():
    s = vt.dbc_summary(F("body.dbc"))
    assert s["messages"] == 2 and s["signals"] == 4 and s["nodes"] == ["BCM", "ESP", "GW"]
    assert s["extended_ids"] == 1
    m = vt.dbc_message(F("body.dbc"), "0x1A0")
    assert m["name"] == "BrakeStatus" and m["cycle_ms"] == 20 and m["comment"] == "Brake system status"
    bp = next(x for x in m["signals"] if x["name"] == "BrakePressure")
    assert bp["factor"] == 0.1 and bp["unit"] == "bar" and bp["receivers"] == ["BCM", "GW"]
    assert bp["comment"] == "Master cylinder pressure"
    assert next(x for x in m["signals"] if x["name"] == "BrakeLightReq")["choices"] == {0: "Off", 1: "On"}


def test_dbc_find():
    r = vt.dbc_find(F("body.dbc"), "brake", "signal")
    assert {x["signal"] for x in r} == {"BrakePressure", "BrakeLightReq"}


def test_arxml_queries():
    s = vt.arxml_summary(F("ecu.arxml"))
    assert "AUTOSAR_00049.xsd" in s["schema"] and s["types"]["APPLICATION-SW-COMPONENT-TYPE"] == 1
    found = vt.arxml_find(F("ecu.arxml"), name="brake", type="APPLICATION-SW-COMPONENT-TYPE")
    assert found == [{"path": "/Components/BrakeLightCtrl", "type": "APPLICATION-SW-COMPONENT-TYPE"}]
    el = vt.arxml_element(F("ecu.arxml"), "/Components/BrakeLightCtrl", depth=3)
    assert el["content"]["PORTS"]["R-PORT-PROTOTYPE"]["SHORT-NAME"] == "BrakePressureIn"
    refs = vt.arxml_refs(F("ecu.arxml"), "/Interfaces/BrakePressure_If")
    assert refs and refs[0]["from"] == "/Components/BrakeLightCtrl/BrakePressureIn"


def test_cdd():
    s = vt.cdd_summary(F("ecu.cdd"))
    assert s["ecu"] == "BCM" and s["dtcs"] == 1 and s["diag_classes"][0]["instances"] == 2
    assert [x["qual"] for x in vt.cdd_services(F("ecu.cdd"), "F190")] == ["VIN_F190"]


def test_capl_index_and_lint():
    idx = vt.capl_index(F("test.can"))
    assert "on timer tCycle" in idx["handlers"] and "TC_BrakeLight()" in idx["functions"]
    issues = vt.capl_lint(F("test.can"))
    assert any("tUnused" in i and "setTimer" in i for i in issues)
    assert any("include not found: missing.cin" in i for i in issues)
    assert not any("unbalanced" in i for i in issues)


def test_server_over_stdio():
    env = {**os.environ, "PYTHONPATH": os.path.join(ROOT, "..", "pycommon")}
    msgs = [
        {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18"}},
        {"jsonrpc": "2.0", "method": "notifications/initialized"},
        {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
        {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "dbc_summary", "arguments": {"path": F("body.dbc")}}},
        {"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "dbc_message", "arguments": {"path": F("body.dbc"), "message": "Nope"}}},
    ]
    p = subprocess.run([sys.executable, os.path.join(ROOT, "server.py")], input="\n".join(json.dumps(m) for m in msgs) + "\n",
                       capture_output=True, text=True, env=env, timeout=30)
    out = [json.loads(l) for l in p.stdout.splitlines() if l.strip()]
    assert [o["id"] for o in out] == [1, 2, 3, 4]
    names = {t["name"] for t in out[1]["result"]["tools"]}
    assert {"dbc_summary", "arxml_find", "cdd_services", "capl_lint", "canoe_run_test", "davinci_cli"} <= names
    assert json.loads(out[2]["result"]["content"][0]["text"])["messages"] == 2
    assert out[3]["result"]["isError"] is True
