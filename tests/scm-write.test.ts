import { describe, expect, it } from "vitest";
import { ScmWriter, cliArg, cliComment, compactOutput, parseChangesets, parseWorkspaces, type ScmWriteDeps } from "../src/main/scm-write";
import type { CliRunner } from "../src/main/scm";

function writer(o: Partial<ScmWriteDeps> & { out?: (args: string[]) => { code?: number; stdout?: string; stderr?: string } } = {}) {
  const calls: string[][] = [];
  const run: CliRunner = async (args) => { calls.push(args); const r = o.out?.(args) ?? {}; return { code: r.code ?? 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" }; };
  const w = new ScmWriter({
    cli: o.cli ?? (() => ({ run, repo: "https://alm/ccm" })), readOnly: o.readOnly ?? (() => false), allowDeliver: o.allowDeliver ?? (() => true),
    streamNames: o.streamNames ?? (async () => ["Body Main"]),
  });
  return { w, calls };
}

describe("EWM SCM command line output", () => {
  it("reads workspaces and change sets from the CLI's JSON, whatever wraps them", () => {
    expect(parseWorkspaces(`Some banner\n{"workspaces":[{"name":"mari CAN fix","uuid":"_W1","owner":{"name":"Mari"},"flow-target":{"name":"Body Main"},"desc":"x"}]}`))
      .toEqual([{ name: "mari CAN fix", id: "_W1", owner: "Mari", description: "x", stream: "Body Main" }]);
    const cs = parseChangesets(JSON.stringify({ workspaces: [{ components: [{ name: "BodyCtrl", uuid: "_C1", "outgoing-changes": [
      { uuid: "_CS1", alias: "1234", comment: "Fix CAN timeout", author: { name: "Mari" }, state: "complete", workitems: [{ "workitem-number": 42 }] },
      { uuid: "_CS2", comment: "WIP", state: "incomplete" }] }] }] }));
    expect(cs).toEqual([
      { id: "_CS1", alias: "1234", comment: "Fix CAN timeout", author: "Mari", complete: true, workItems: ["42"] },
      { id: "_CS2", comment: "WIP", complete: false },
    ]);
    expect(compactOutput("Delivering...\nDelivered 2 change sets.\n")).toBe("Delivering...\nDelivered 2 change sets.");
  });

  it("never passes a value the CLI would read as an option, or a multi-line one", () => {
    expect(() => cliArg("--overwrite-uncommitted", "workspace")).toThrow(/may not start/);
    expect(() => cliArg("a\nb", "workspace")).toThrow(/single line/);
    expect(() => cliArg("  ", "stream")).toThrow(/required/);
    expect(cliComment("-- Fix\r\nCAN timeout")).toBe("Fix CAN timeout");
  });
});

describe("EWM source control changes", () => {
  it("creates a workspace on a stream, loads it into the sandbox and checks in with a work item link", async () => {
    const { w, calls } = writer({ out: (a) => a[0] === "checkin" ? { stdout: `{"changes":[{"uuid":"_CS9","comment":"Fix CAN timeout","state":"incomplete"}]}` } : {} });
    await w.createWorkspace("mari CAN fix", "Body Main", "for 42");
    await w.load("mari CAN fix", "/work/ewm/mari_CAN_fix", ["BodyCtrl"]);
    const r = await w.checkin(["/work/ewm/mari_CAN_fix/src/can.c"], { comment: "Fix CAN timeout", workItem: "42" });
    expect(r.changesets[0]!.id).toBe("_CS9");
    expect(calls).toEqual([
      ["create", "workspace", "-r", "https://alm/ccm", "-s", "Body Main", "--description", "for 42", "mari CAN fix", "--json"],
      ["load", "-r", "https://alm/ccm", "-d", "/work/ewm/mari_CAN_fix", "mari CAN fix", "BodyCtrl"],
      ["checkin", "-r", "https://alm/ccm", "--comment", "Fix CAN timeout", "--json", "/work/ewm/mari_CAN_fix/src/can.c"],
      ["changeset", "associate", "-r", "https://alm/ccm", "_CS9", "42"],
    ]);
  });

  it("refuses to load, accept into or check in to a stream: streams change only by deliver", async () => {
    const { w, calls } = writer();
    await expect(w.load("body main", "/work/ewm/x")).rejects.toThrow(/is a stream.*scm_create_workspace/);
    await expect(w.accept("Body Main")).rejects.toThrow(/is a stream/);
    await expect(w.createWorkspace("Body Main", "Body Main")).rejects.toThrow(/is a stream/);
    expect(calls).toEqual([]);
  });

  it("read-only mode blocks every change but still reads", async () => {
    const { w, calls } = writer({ readOnly: () => true, out: () => ({ stdout: "{}" }) });
    await expect(w.checkin(["/w/a.c"], { comment: "x" })).rejects.toThrow(/read-only/);
    await expect(w.accept("mine")).rejects.toThrow(/read-only/);
    await expect(w.deliver("mine", "Body Main", "Body Main")).rejects.toThrow(/read-only/);
    await expect(w.updateChangeset("1234", { complete: true })).rejects.toThrow(/read-only/);
    await w.status("/w");
    expect(calls).toEqual([["show", "status", "-r", "https://alm/ccm", "-d", "/w", "--json"]]);
  });

  it("delivers only with the setting on and the stream name repeated, and only the change sets named", async () => {
    const off = writer({ allowDeliver: () => false });
    await expect(off.w.deliver("mine", "Body Main", "Body Main")).rejects.toThrow(/Agents may deliver/);
    const { w, calls } = writer();
    await expect(w.deliver("mine", "Body Main", "body main")).rejects.toThrow(/confirm must repeat/);
    await w.deliver("mine", "Body Main", "Body Main", ["1234", "1235"]);
    expect(off.calls.concat(calls)).toEqual([["deliver", "-r", "https://alm/ccm", "-s", "mine", "-t", "Body Main", "--json", "-c", "1234", "1235"]]);
  });

  it("discard needs the change set repeated; accept passes the sandbox and source", async () => {
    const { w, calls } = writer();
    await expect(w.discard("mine", "1234", "1235")).rejects.toThrow(/confirm/);
    await w.discard("mine", "1234", "1234");
    await w.accept("mine", { source: "Body Main", sandbox: "/w/ewm/mine" });
    expect(calls).toEqual([
      ["discard", "-r", "https://alm/ccm", "-w", "mine", "1234"],
      ["accept", "-r", "https://alm/ccm", "-t", "mine", "-s", "Body Main", "-d", "/w/ewm/mine", "--json"],
    ]);
  });

  it("explains conflicts and a missing command line", async () => {
    const { w } = writer({ out: () => ({ code: 2, stderr: "Problem running 'deliver':\nThere are unresolved conflicts in the workspace." }) });
    await expect(w.deliver("mine", "Body Main", "Body Main")).rejects.toThrow(/unresolved conflicts.*scm_status/);
    const none = new ScmWriter({ cli: () => null, readOnly: () => false, allowDeliver: () => true });
    await expect(none.workspaces()).rejects.toThrow(/EWM SCM command line/);
  });
});
