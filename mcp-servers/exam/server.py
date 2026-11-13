"""exam MCP server: EXAM test automation (MicroNova / Volkswagen Group) through the EXAM RESTapi.

The same tool registry is used by exam_cli.py, so agents can call every tool from a shell when MCP is blocked.
"""
from __future__ import annotations

import os
import sys
from typing import Any

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(1, os.path.join(os.path.dirname(HERE), "pycommon"))

import exam_setup as SETUP  # noqa: E402
import exam_tools as X  # noqa: E402
from mcp_stdio import McpServer  # noqa: E402

S = McpServer("exam")


def schema(props: dict, required: list[str] | None = None) -> dict:
    return {"type": "object", "properties": props, "required": required or []}


STR = {"type": "string"}
MODEL = {"model_name": {"type": "string", "description": "default: Settings → EXAM"}, "target_endpoint": STR, "model_config_uuid": STR}


@S.tool("EXAM connection check: RESTapi reachable?, job running, current test case, API/TCG versions.")
def exam_status() -> dict[str, Any]:
    return X.status()


@S.tool("Start EXAM headless with the RESTapi (needs install folder + license server in Settings) and wait until it answers.",
        schema({"install": STR, "workspace": STR, "wait_s": {"type": "integer"}}))
def exam_start(install: str = "", workspace: str = "", wait_s: int = 180) -> dict[str, Any]:
    return X.start(install, workspace, wait_s)


@S.tool("Check the EXAM setup: installation, RESTapi plugin, license server, application server, model, RESTapi. Each item ok/warn/fail with a fix.")
def exam_setup_check() -> dict[str, Any]:
    r = SETUP.setup(install=False)
    return {"home": r["home"], "ok": r["ok"], "checks": r["checks"]}


@S.tool("Set up EXAM: detect the installation and install the RESTapi plugin from the package in Settings (or `package`), then check.",
        schema({"package": {"type": "string", "description": "path or http(s) URL of the plugin .jar/.zip"}, "install": {"type": "boolean"}}))
def exam_setup(package: str = "", install: bool = True) -> dict[str, Any]:
    return SETUP.setup(package, install)


@S.tool("Shut EXAM down (only an instance you started).")
def exam_shutdown() -> str:
    return X.shutdown()


@S.tool("Load a model from the EXAM application server into the workspace.", schema({**MODEL, "project_name": STR}))
def exam_open_model(model_name: str = "", target_endpoint: str = "", model_config_uuid: str = "", project_name: str = "") -> str:
    return X.open_model(model_name, target_endpoint, model_config_uuid, project_name)


@S.tool("Remove a project (or all) from the EXAM REST workspace.", schema({"project_name": STR}))
def exam_close_project(project_name: str = "") -> str:
    return X.close_project(project_name)


@S.tool("Filter the next test run by test-case attributes.",
        schema({"filters": {"type": "array", "items": {"type": "object", "properties": {"name": STR, "value": STR, "adminCases": {"type": "boolean"}, "activateTestcases": {"type": "boolean"}}, "required": ["name", "value"]}}}, ["filters"]))
def exam_set_filter(filters: list) -> str:
    return X.set_filter(filters)


@S.tool("Run a TestSuite/TestCampaign/TestCase (UUID, ID or full scoped name) on a system configuration; waits by default.",
        schema({"test_object": STR, "system_config": {"type": "string", "description": "UUID, ID or full scoped name"}, **MODEL,
                "report_project": STR, "report_prefix": STR, "python_path": STR, "log_level": {"type": "string", "enum": X.LOG_LEVELS},
                "execution_file": {"type": "string", "description": "exported execution file instead of the model"},
                "wait": {"type": "boolean"}, "timeout_s": {"type": "integer"}}, ["test_object"]))
def exam_run(test_object: str, system_config: str = "", model_name: str = "", target_endpoint: str = "", model_config_uuid: str = "",
             report_project: str = "", report_prefix: str = "", python_path: str = "", log_level: str = "WARNING",
             execution_file: str = "", wait: bool = True, timeout_s: int = 3600) -> dict[str, Any]:
    return X.run_tests(test_object, system_config, model_name, target_endpoint, model_config_uuid, report_project, report_prefix,
                       python_path, log_level, execution_file, wait, timeout_s)


@S.tool("Wait for the running test run to finish (or time out) and report progress.", schema({"timeout_s": {"type": "integer"}}))
def exam_wait(timeout_s: int = 600) -> dict[str, Any]:
    return X.wait_until_done(timeout_s)


@S.tool("Stop the running test run.")
def exam_stop() -> str:
    return X.stop()


@S.tool("Convert the EXAM reports of a report project to JUnit XML.", schema({"report_project": STR}))
def exam_convert_junit(report_project: str = "") -> str:
    return X.convert_junit(report_project)


@S.tool("Compact pass/fail summary of JUnit XML reports (file, folder or glob).",
        schema({"path": STR, "failures_only": {"type": "boolean"}, "limit": {"type": "integer"}}, ["path"]))
def exam_results(path: str, failures_only: bool = True, limit: int = 40) -> dict[str, Any]:
    return X.junit_summary(path, failures_only, limit)


@S.tool("Test Case Generator: implement test cases from the keyword test descriptions of a model element.",
        schema({"element": {"type": "string", "description": "UUID / full scoped name of the package or test case"}, **MODEL,
                "description_source": {"type": "string", "enum": ["description", "beschreibung"]},
                "error_handling": {"type": "string", "enum": ["error_step", "skip", "abort"]}, "document_in_report": {"type": "boolean"},
                "frame_functions": {"type": "array", "items": STR}, "mapping_list": {"type": "array", "items": STR},
                "test_case_states": {"type": "array", "items": STR}, "variant": STR, "state_for_success": STR, "state_for_fail": STR}, ["element"]))
def exam_generate(element: str, model_name: str = "", target_endpoint: str = "", model_config_uuid: str = "", description_source: str = "description",
                  error_handling: str = "error_step", document_in_report: bool = True, frame_functions: list | None = None,
                  mapping_list: list | None = None, test_case_states: list | None = None, variant: str = "",
                  state_for_success: str = "", state_for_fail: str = "") -> dict[str, Any]:
    return X.generate(element, model_name, target_endpoint, model_config_uuid, description_source, error_handling, document_in_report,
                      frame_functions, mapping_list, test_case_states, variant, state_for_success, state_for_fail)


@S.tool("Run a Groovy script inside EXAM on the loaded model. Write findings to the file path ${OUT}; its content is returned.",
        schema({"script": STR, "start_element": STR, **MODEL, "load_model": {"type": "boolean"}}, ["script"]))
def exam_groovy(script: str, start_element: str = "", model_name: str = "", target_endpoint: str = "", model_config_uuid: str = "",
                load_model: bool = True) -> dict[str, Any]:
    return X.groovy(script, start_element, model_name, target_endpoint, model_config_uuid, load_model)


@S.tool("Read the verified notes about this site's EXAM setup (model structure, mapping names, Groovy API facts).", schema({"query": STR}))
def exam_notes(query: str = "") -> str:
    return X.notes_read(query)


@S.tool("Record one verified fact about this site's EXAM setup so later sessions don't rediscover it.", schema({"note": STR, "topic": STR}, ["note"]))
def exam_note_add(note: str, topic: str = "general") -> str:
    return X.notes_add(note, topic)


if __name__ == "__main__":
    S.run()
