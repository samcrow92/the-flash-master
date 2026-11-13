"""exam tools against a fake EXAM RESTapi (same endpoints/payloads the Jenkins plugin uses)."""
import json
import os
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CALLS: list = []
STATE = {"polls": 0}


class Fake(BaseHTTPRequestHandler):
    def log_message(self, *a):  # quiet
        pass

    def _send(self, code, obj=None):
        body = b"" if obj is None else json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n)) if n else None

    def do_GET(self):
        p = self.path.replace("/examRest", "")
        CALLS.append(("GET", p, None))
        if p == "/testrun/status":
            STATE["polls"] += 1
            running = 0 < STATE.get("started", 0) and STATE["polls"] < STATE["started"] + 3
            return self._send(200, {"jobRunning": running, "jobName": "TestRun" if STATE.get("started") else "", "testRunState": 0,
                                    "status": {"tcName": "TC_Brake_01", "currentTestCaseIdx": 1, "testCaseCount": 4}})
        if p in ("/workspace/apiVersion", "/TCG/apiVersion"):
            return self._send(200, {"major": 2, "minor": 1, "fix": 0})
        if p.startswith("/testrun/convertToJunit/"):
            return self._send(200)
        return self._send(404, {"error": "unknown"})

    def do_POST(self):
        p = self.path.replace("/examRest", "")
        body = self._body()
        CALLS.append(("POST", p, body))
        if p == "/testrun/start":
            STATE["started"] = STATE["polls"] + 1
        if p == "/groovy/executeGroovyScript":
            out = body["script"].split("OUT=")[1].strip()
            with open(out, "w", encoding="utf-8") as fh:
                fh.write("packages: 3")
        if p == "/TCG/generate":
            return self._send(200, {"message": "2 test cases generated", "code": 0, "exception": ""})
        return self._send(200)

    do_PUT = do_POST


def serve():
    srv = HTTPServer(("127.0.0.1", 0), Fake)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def cli(args, env):
    return subprocess.run([sys.executable, os.path.join(ROOT, "exam_cli.py"), *args], capture_output=True, text=True, env=env, timeout=60)


def test_cli_against_fake_exam(tmp_path):
    srv = serve()
    env = {**os.environ, "EXAM_REST_URL": f"http://127.0.0.1:{srv.server_port}/examRest", "EXAM_MODEL": "BrakeModel",
           "EXAM_TARGET_ENDPOINT": "http://examserver:8080", "EXAM_REPORT_PROJECT": "Reports", "EXAM_NOTES": str(tmp_path / "notes.md"), "EXAM_POLL_S": "0.05"}
    sys.path.insert(0, ROOT)
    try:
        r = cli(["exam_status"], env)
        assert r.returncode == 0, r.stderr
        st = json.loads(r.stdout)
        assert st["api"] == "2.1.0" and st["tcgApi"] == "2.1.0"

        r = cli(["exam_open_model"], env)
        assert r.returncode == 0 and "BrakeModel" in r.stdout
        assert CALLS[-1][2] == {"projectName": "BrakeModel", "modelName": "BrakeModel", "targetEndpoint": "http://examserver:8080", "modelConfigUUID": ""}

        r = cli(["exam_set_filter", json.dumps({"filters": [{"name": "Priority", "value": "1"}]})], env)
        assert r.returncode == 0
        assert CALLS[-1][2] == {"testrunFilter": [{"name": "Priority", "value": "1", "adminCases": False, "activateTestcases": False}]}

        r = cli(["exam_run", json.dumps({"test_object": "BrakeModel.Suites.Smoke", "system_config": "HIL_1", "timeout_s": 60})], env)
        assert r.returncode == 0, r.stdout + r.stderr
        res = json.loads(r.stdout)
        assert res["finished"] is True
        start = next(c for c in CALLS if c[1] == "/testrun/start")[2]
        assert start["testObject"] == "BrakeModel.Suites.Smoke" and start["systemConfig"] == "HIL_1"
        assert start["reportProject"] == {"projectName": "Reports"} and start["logLevelTC"] == "WARNING"

        r = cli(["exam_generate", json.dumps({"element": "BrakeModel.Specs", "error_handling": "skip"})], env)
        assert r.returncode == 0 and "2 test cases generated" in r.stdout
        gen = CALLS[-1][2]
        assert gen["errorHandling"] == "Skip TestCase" and gen["descriptionSource"] == "Description"

        script = tmp_path / "g.json"
        script.write_text(json.dumps({"script": "// OUT=${OUT}", "load_model": False}))
        r = cli(["exam_groovy", f"@{script}"], env)
        assert r.returncode == 0 and "packages: 3" in r.stdout

        assert cli(["exam_note_add", json.dumps({"note": "Suites live under Root.Tests", "topic": "model"})], env).returncode == 0
        assert "Root.Tests" in cli(["exam_notes", json.dumps({"query": "suites"})], env).stdout
    finally:
        srv.shutdown()


def test_unreachable_and_junit(tmp_path):
    env = {**os.environ, "EXAM_REST_URL": "http://127.0.0.1:9/examRest"}
    r = cli(["exam_status"], env)
    assert r.returncode == 1 and "not reachable" in r.stdout
    (tmp_path / "r.xml").write_text('<testsuite><testcase name="a" classname="S"/><testcase name="b" classname="S">'
                                    '<failure message="brake light off">x</failure></testcase></testsuite>')
    r = cli(["exam_results", json.dumps({"path": str(tmp_path)})], env)
    out = json.loads(r.stdout)
    assert out["tests"] == 2 and out["failures"] == 1 and out["cases"][0]["message"] == "brake light off"


def test_mcp_lists_tools():
    msgs = [{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}}, {"jsonrpc": "2.0", "id": 2, "method": "tools/list"}]
    p = subprocess.run([sys.executable, os.path.join(ROOT, "server.py")], input="\n".join(json.dumps(m) for m in msgs) + "\n",
                       capture_output=True, text=True, timeout=30)
    names = {t["name"] for t in json.loads(p.stdout.splitlines()[1])["result"]["tools"]}
    assert {"exam_status", "exam_start", "exam_open_model", "exam_run", "exam_generate", "exam_groovy", "exam_results"} <= names
