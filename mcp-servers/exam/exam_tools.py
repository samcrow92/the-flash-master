"""EXAM (MicroNova / Volkswagen Group) test automation tools for TheFlashMaster.

Talks to the EXAM RESTapi plugin (base URL http://localhost:<port>/examRest). Endpoints, payload fields and the
EXAM.exe start arguments were taken from MicroNova's open-source Jenkins plugin (github.com/jenkinsci/exam-plugin):

  GET  /testrun/status            {jobRunning, jobName, testRunState, status{tcName, tcFullScopedName, testCaseCount,
                                   currentTestCaseIdx, expectedRuntime, currentRuntime, remainingRuntime}}
  GET  /workspace/apiVersion      {major, minor, fix}
  POST /workspace/createProject   {projectName, modelName, targetEndpoint, modelConfigUUID}
  POST /workspace/delete[?projectName=]
  GET  /workspace/shutdown
  POST /testrun/setFilter         {testrunFilter: [{name, value, adminCases, activateTestcases}]}
  POST /testrun/start             TestConfiguration (see run_tests)
  PUT|POST /testrun/stop?timeout=300
  GET  /testrun/convertToJunit/<reportProject>
  POST /groovy/executeGroovyScript {script, startElement}
  GET  /TCG/apiVersion ; POST /TCG/generate  (Test Case Generator)

Everything here is dependency-free (urllib) so it runs from the MCP server and from the plain CLI (exam_cli.py),
which is what agents use when MCP is blocked. Configuration comes from environment variables set by the app
(Settings -> EXAM) and can be overridden per call.
"""
from __future__ import annotations

import glob
import json
import os
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from typing import Any

# Values used by the RESTapi (display strings, as the Jenkins plugin sends them for TCG API >= 2.0.3).
ERROR_HANDLING = {"error_step": "Generate Error Step", "skip": "Skip TestCase", "abort": "Abort Generation"}
DESCRIPTION_SOURCE = {"description": "Description", "beschreibung": "Beschreibung"}
LOG_LEVELS = ["OFF", "ERROR", "WARNING", "INFO", "DEBUG", "INTERNAL"]


def env(key: str, default: str = "") -> str:
    return (os.environ.get(key) or default).strip()


def port() -> int:
    return int(env("EXAM_REST_PORT", "8085") or 8085)


def base_url(p: int | None = None) -> str:
    return env("EXAM_REST_URL") or f"http://localhost:{p or port()}/examRest"


# The REST API is local: never send it through a corporate proxy.
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def http(method: str, path: str, body: Any = None, timeout: float = 60, p: int | None = None) -> tuple[int, Any]:
    """Call the EXAM RESTapi. Returns (status, parsed JSON or text). Raises RuntimeError when EXAM is unreachable."""
    url = base_url(p) + path
    data = None
    headers = {"Accept": "application/json"}
    if body is not None:
        data = (body if isinstance(body, str) else json.dumps(body)).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with _OPENER.open(req, timeout=timeout) as r:
            raw = r.read().decode("utf-8", "replace")
            code = r.status
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        code = e.code
    except (urllib.error.URLError, OSError) as e:
        raise RuntimeError(f"EXAM RESTapi not reachable at {url} ({getattr(e, 'reason', e)}). Start EXAM with exam_start, "
                           "or check Settings → EXAM (REST port) and that the RESTapi plugin is installed.") from e
    try:
        return code, json.loads(raw) if raw.strip() else None
    except json.JSONDecodeError:
        return code, raw.strip()


def ok(code: int, payload: Any, what: str) -> Any:
    if code >= 400:
        detail = payload if isinstance(payload, str) else json.dumps(payload)
        raise RuntimeError(f"{what} failed: HTTP {code} {detail[:500]}")
    return payload


# ---------------------------------------------------------------- connection / lifecycle

def status() -> dict[str, Any]:
    code, st = http("GET", "/testrun/status", timeout=15)
    st = ok(code, st, "status") or {}
    out: dict[str, Any] = {"url": base_url(), "jobRunning": st.get("jobRunning"), "jobName": st.get("jobName"),
                           "testRunState": st.get("testRunState")}
    run = st.get("status") or {}
    if run:
        out["testrun"] = {k: run.get(k) for k in ("tcName", "tcFullScopedName", "currentTestCaseIdx", "testCaseCount",
                                                  "currentRuntime", "remainingRuntime") if run.get(k) not in (None, "")}
    for key, path in (("api", "/workspace/apiVersion"), ("tcgApi", "/TCG/apiVersion")):
        try:
            c, v = http("GET", path, timeout=10)
            if c < 400 and isinstance(v, dict):
                out[key] = f"{v.get('major', 0)}.{v.get('minor', 0)}.{v.get('fix', 0)}"
        except RuntimeError:
            pass
    return out


def find_exe(install: str = "") -> str:
    p = install or env("EXAM_HOME")
    if not p:
        raise RuntimeError("EXAM install folder not set — Settings → EXAM → Install folder (the folder containing EXAM.exe)")
    exe = p if p.lower().endswith(".exe") else os.path.join(p, "EXAM.exe")
    if not os.path.isfile(exe):
        raise RuntimeError(f"EXAM.exe not found at {exe}")
    return exe


def start(install: str = "", workspace: str = "", wait_s: int = 180) -> dict[str, Any]:
    """Start EXAM headless with the RESTapi enabled (same arguments as the Jenkins plugin) and wait until it answers."""
    try:
        return {"alreadyRunning": True, **status()}
    except RuntimeError:
        pass
    exe = find_exe(install)
    lic_host, lic_port = env("EXAM_LICENSE_HOST"), env("EXAM_LICENSE_PORT")
    if not lic_host or not lic_port or lic_port == "0":
        raise RuntimeError("License server not set — Settings → EXAM → License host / port")
    ws = workspace or env("EXAM_WORKSPACE") or os.path.join(tempfile.gettempdir(), "flashmaster_exam_ws")
    os.makedirs(ws, exist_ok=True)
    conf = os.path.join(ws, ".exam_configuration")
    args = [exe, "-data", ws, "-configuration", conf, "--launcher.appendVmargs", "-vmargs", "-DUSE_CONSOLE=true",
            "-DRESTAPI=true", f"-DRESTAPI_PORT={port()}", f"-DLICENSE_PORT={lic_port}", f"-DLICENSE_HOST={lic_host}",
            "-Dfile.encoding=UTF-8", "-Dsun.jnu.encoding=UTF-8"]
    args += [a for a in env("EXAM_JAVA_OPTS").split(" ") if a]
    log = open(os.path.join(ws, "flashmaster_exam.log"), "ab")  # noqa: SIM115 - handed to the child process
    flags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0) | getattr(subprocess, "DETACHED_PROCESS", 0)
    proc = subprocess.Popen(args, stdout=log, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, creationflags=flags)
    deadline = time.time() + max(10, int(wait_s))
    while time.time() < deadline:
        if proc.poll() is not None:
            raise RuntimeError(f"EXAM exited with code {proc.returncode} — see {log.name}")
        try:
            return {"started": True, "pid": proc.pid, "workspace": ws, **status()}
        except RuntimeError:
            time.sleep(3)
    raise RuntimeError(f"EXAM started (pid {proc.pid}) but the RESTapi did not answer within {wait_s}s — see {log.name}")


def shutdown() -> str:
    code, body = http("GET", "/workspace/shutdown", timeout=60)
    ok(code, body, "shutdown")
    return "EXAM shutdown requested"


# ---------------------------------------------------------------- model / projects

def open_model(model_name: str = "", target_endpoint: str = "", model_config_uuid: str = "", project_name: str = "") -> str:
    """Load a model from the EXAM application server into the REST workspace (/workspace/createProject)."""
    model = model_name or env("EXAM_MODEL")
    target = target_endpoint or env("EXAM_TARGET_ENDPOINT")
    if not model or not target:
        raise RuntimeError("model_name and target_endpoint are required (or set them in Settings → EXAM)")
    body = {"projectName": project_name or model, "modelName": model, "targetEndpoint": target,
            "modelConfigUUID": model_config_uuid or env("EXAM_MODEL_CONFIG")}
    code, resp = http("POST", "/workspace/createProject", body, timeout=900)
    ok(code, resp, "createProject")
    return f"model {model} loaded as project {body['projectName']}"


def close_project(project_name: str = "") -> str:
    path = "/workspace/delete" + (f"?projectName={urllib.request.quote(project_name)}" if project_name else "")
    code, resp = http("POST", path, timeout=300)
    ok(code, resp, "delete")
    return f"removed {'project ' + project_name if project_name else 'all projects'} from the EXAM workspace"


# ---------------------------------------------------------------- test runs

def set_filter(filters: list[dict[str, Any]]) -> str:
    """filters: [{name, value, adminCases?, activateTestcases?}] — name/value are EXAM test-case attributes."""
    body = {"testrunFilter": [{"name": f["name"], "value": f["value"], "adminCases": bool(f.get("adminCases", False)),
                               "activateTestcases": bool(f.get("activateTestcases", False))} for f in filters]}
    code, resp = http("POST", "/testrun/setFilter", body, timeout=120)
    ok(code, resp, "setFilter")
    return f"{len(filters)} filter(s) set"


def wait_until_done(timeout_s: int, poll_s: float = 0) -> dict[str, Any]:
    poll_s = poll_s or float(env("EXAM_POLL_S", "5") or 5)
    deadline = time.time() + max(5, timeout_s)
    seen = False
    last: dict[str, Any] = {}
    while time.time() < deadline:
        code, st = http("GET", "/testrun/status", timeout=30)
        last = ok(code, st, "status") or {}
        if not seen:
            seen = str(last.get("jobName", "")).lower() == "testrun"
        elif not last.get("jobRunning"):
            return {"finished": True, "state": last.get("testRunState")}
        time.sleep(poll_s)
    run = last.get("status") or {}
    return {"finished": False, "timeout_s": timeout_s, "current": run.get("tcName"), "progress": f"{run.get('currentTestCaseIdx')}/{run.get('testCaseCount')}"}


def run_tests(test_object: str, system_config: str = "", model_name: str = "", target_endpoint: str = "",
              model_config_uuid: str = "", report_project: str = "", report_prefix: str = "", python_path: str = "",
              log_level: str = "WARNING", execution_file: str = "", wait: bool = True, timeout_s: int = 3600) -> dict[str, Any]:
    """Start a test run of a TestSuite / TestCampaign / TestCase (UUID, ID or full scoped name)."""
    model = model_name or env("EXAM_MODEL")
    level = log_level.upper() if log_level.upper() in LOG_LEVELS else "WARNING"
    cfg: dict[str, Any] = {
        "modelProject": {"projectName": model, "modelName": model, "targetEndpoint": target_endpoint or env("EXAM_TARGET_ENDPOINT"),
                         "modelConfigUUID": model_config_uuid or env("EXAM_MODEL_CONFIG")},
        "reportProject": {"projectName": report_project or env("EXAM_REPORT_PROJECT")},
        "systemConfig": system_config or env("EXAM_SYSTEM_CONFIG"),
        "testObject": test_object,
        "logLevelTC": level, "logLevelTL": level, "logLevelLC": level,
        "reportPrefix": report_prefix,
        "pythonPath": python_path or env("EXAM_PYTHON"),
        "useExecutionFile": bool(execution_file),
        "pathPCode": execution_file,
    }
    if not cfg["reportProject"]["projectName"]:
        cfg["reportProject"] = {"projectName": "NO_REPORT"}
    code, resp = http("POST", "/testrun/start", cfg, timeout=300)
    ok(code, resp, "testrun/start")
    out: dict[str, Any] = {"started": test_object}
    if wait:
        out.update(wait_until_done(timeout_s))
    return out


def stop() -> str:
    code, resp = http("PUT", "/testrun/stop?timeout=300", timeout=330)
    if code == 405:
        code, resp = http("POST", "/testrun/stop?timeout=300", timeout=330)
    ok(code, resp, "testrun/stop")
    return "test run stopped"


def convert_junit(report_project: str = "") -> str:
    rp = report_project or env("EXAM_REPORT_PROJECT")
    if not rp:
        raise RuntimeError("report_project is required (or set Settings → EXAM → Report project)")
    code, resp = http("GET", f"/testrun/convertToJunit/{urllib.request.quote(rp)}", timeout=600)
    ok(code, resp, "convertToJunit")
    return f"reports of {rp} converted to JUnit (look in the EXAM workspace under target/test-reports)"


def junit_summary(path: str, failures_only: bool = True, limit: int = 40) -> dict[str, Any]:
    """Compact summary of JUnit XML reports (file, folder or glob)."""
    files = [path] if os.path.isfile(path) else glob.glob(os.path.join(path, "**", "*.xml"), recursive=True) if os.path.isdir(path) else glob.glob(path, recursive=True)
    if not files:
        raise RuntimeError(f"no JUnit XML found at {path}")
    tot = {"tests": 0, "failures": 0, "errors": 0, "skipped": 0}
    cases: list[dict[str, Any]] = []
    for f in files:
        try:
            root = ET.parse(f).getroot()
        except ET.ParseError:
            continue
        for tc in root.iter("testcase"):
            tot["tests"] += 1
            res, msg = "passed", ""
            for kind in ("failure", "error", "skipped"):
                el = tc.find(kind)
                if el is not None:
                    res = kind
                    msg = (el.get("message") or (el.text or "")).strip().splitlines()[0][:200] if (el.get("message") or el.text) else ""
                    tot["failures" if kind == "failure" else "errors" if kind == "error" else "skipped"] += 1
                    break
            if not failures_only or res in ("failure", "error"):
                cases.append({"name": tc.get("name"), "class": tc.get("classname"), "result": res, "time": tc.get("time"), **({"message": msg} if msg else {})})
    return {"files": len(files), **tot, "passed": tot["tests"] - tot["failures"] - tot["errors"] - tot["skipped"],
            "cases": cases[:limit], **({"more": len(cases) - limit} if len(cases) > limit else {})}


# ---------------------------------------------------------------- Test Case Generator (TCG)

def generate(element: str, model_name: str = "", target_endpoint: str = "", model_config_uuid: str = "",
             description_source: str = "description", error_handling: str = "error_step", document_in_report: bool = True,
             frame_functions: list[str] | None = None, mapping_list: list[str] | None = None,
             test_case_states: list[str] | None = None, variant: str = "", state_for_success: str = "",
             state_for_fail: str = "") -> dict[str, Any]:
    """Run the EXAM Test Case Generator on a model element (package/test case) whose test descriptions are written in
    the generator's keyword syntax. Loads the model first."""
    open_model(model_name, target_endpoint, model_config_uuid)
    body: dict[str, Any] = {
        "element": element,
        "descriptionSource": DESCRIPTION_SOURCE.get(description_source.lower(), description_source),
        "overwriteDescriptionSource": True,
        "documentInReport": bool(document_in_report),
        "errorHandling": ERROR_HANDLING.get(error_handling.lower(), error_handling),
        "overwriteFrameSteps": frame_functions is not None, "frameFunctions": frame_functions or [],
        "overwriteMappingList": mapping_list is not None, "mappingList": mapping_list or [],
        "testCaseStates": test_case_states or [], "variant": variant,
        "stateForSuccess": state_for_success, "stateForFail": state_for_fail,
    }
    code, resp = http("POST", "/TCG/generate", body, timeout=1800)
    ok(code, resp, "TCG/generate")
    return resp if isinstance(resp, dict) else {"result": resp or "generated"}


# ---------------------------------------------------------------- Groovy (model access inside EXAM)

def groovy(script: str, start_element: str = "", model_name: str = "", target_endpoint: str = "",
           model_config_uuid: str = "", load_model: bool = True) -> dict[str, Any]:
    """Execute a Groovy script inside EXAM. `${OUT}` in the script is replaced by a temp file path (forward slashes);
    whatever the script writes there is returned, so scripts can report what they found or changed."""
    if load_model:
        open_model(model_name, target_endpoint, model_config_uuid)
    out = os.path.join(tempfile.gettempdir(), f"flash_exam_groovy_{os.getpid()}_{int(time.time() * 1000)}.txt")
    body = {"script": script.replace("${OUT}", out.replace("\\", "/")), "startElement": start_element}
    code, resp = http("POST", "/groovy/executeGroovyScript", body, timeout=1800)
    ok(code, resp, "executeGroovyScript")
    result: dict[str, Any] = {"response": resp if resp not in (None, "") else "ok"}
    if os.path.exists(out):
        with open(out, encoding="utf-8", errors="replace") as fh:
            result["output"] = fh.read()
        os.remove(out)
    return result


# ---------------------------------------------------------------- knowledge notes (verified facts about this site's EXAM)

def notes_path() -> str:
    p = env("EXAM_NOTES") or os.path.join(os.path.expanduser("~"), ".theflashmaster", "exam-notes.md")
    os.makedirs(os.path.dirname(p), exist_ok=True)
    return p


def notes_read(query: str = "") -> str:
    p = notes_path()
    if not os.path.exists(p):
        return "(no notes yet)"
    with open(p, encoding="utf-8") as fh:
        lines = fh.read().splitlines()
    if query:
        q = query.lower()
        lines = [ln for ln in lines if q in ln.lower()]
    return "\n".join(lines) or "(no matching notes)"


def notes_add(note: str, topic: str = "general") -> str:
    with open(notes_path(), "a", encoding="utf-8") as fh:
        fh.write(f"- [{topic}] {note.strip()}\n")
    return f"noted under {topic}"
