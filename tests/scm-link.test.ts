import { describe, expect, it } from "vitest";
import { parseScmLink, scmTarget } from "../src/main/scm";
import { withScmLink } from "../src/main/tools";
import type { ToolDef } from "../src/main/bridge";

const WEB = "https://jazz.corp.com/ccm/web/projects/Body%20SW#action=com.ibm.team.scm.browseElement&workspaceItemId=_PpQZIJsxEe6j6IPBMoyyTQ&componentItemId=_Pp2PAJsxEe6j6IPBMoyyTQ&itemType=com.ibm.team.filesystem.Folder&itemId=_F1aaaaaaaa&path=%2Fspecs%2Fhw_removal";

describe("EWM links", () => {
  it("reads server, stream, component and path from a web UI link", () => {
    expect(parseScmLink(WEB)).toEqual({ repo: "https://jazz.corp.com/ccm", stream: "_PpQZIJsxEe6j6IPBMoyyTQ", component: "_Pp2PAJsxEe6j6IPBMoyyTQ", path: "/specs/hw_removal", folder: "_F1aaaaaaaa" });
    expect(parseScmLink("https://jazz.corp.com/ccm1/web/projects/X#action=com.ibm.team.scm.viewStream&id=_S1aaaaaaaa")).toEqual({ repo: "https://jazz.corp.com/ccm1", stream: "_S1aaaaaaaa" });
    expect(parseScmLink("https://alm/ccm/web/projects/X#action=com.ibm.team.scm.viewChangeSet&id=_CS1aaaaaaa")).toEqual({ repo: "https://alm/ccm", changeset: "_CS1aaaaaaa" });
    expect(parseScmLink("https://alm/ccm/service/com.ibm.team.filesystem.service.internal.rest.IFilesystemContentService/_S1/_C1/src/my%20can.c"))
      .toEqual({ repo: "https://alm/ccm", stream: "_S1", component: "_C1", path: "src/my can.c" });
    expect(parseScmLink("Body Main")).toBeNull();
  });

  it("fills missing arguments from the link, keeps explicit ones, and takes a URL pasted into stream", () => {
    expect(scmTarget({ link: WEB, path: "/specs" })).toMatchObject({ repo: "https://jazz.corp.com/ccm", stream: "_PpQZIJsxEe6j6IPBMoyyTQ", component: "_Pp2PAJsxEe6j6IPBMoyyTQ", path: "/specs" });
    expect(scmTarget({ stream: WEB, pattern: "*.pdf" })).toMatchObject({ stream: "_PpQZIJsxEe6j6IPBMoyyTQ", component: "_Pp2PAJsxEe6j6IPBMoyyTQ", pattern: "*.pdf" });
    expect(scmTarget({ stream: "Body Main" })).toEqual({ stream: "Body Main" });
  });

  it("every scm_* tool takes the link instead of stream and component, and says what is missing without one", async () => {
    let got: any;
    const tool: ToolDef = { set: "jazz", name: "scm_find_files", description: "", inputSchema: { type: "object", properties: {}, required: ["stream", "component", "pattern"] }, handler: async (a) => { got = a; return null; } };
    const t = withScmLink(tool);
    expect((t.inputSchema as any).required).toEqual(["pattern"]);
    expect((t.inputSchema as any).properties.link).toBeTruthy();
    await t.handler({ link: WEB, pattern: "*.pdf" }, { agentId: "" });
    expect(got).toMatchObject({ repo: "https://jazz.corp.com/ccm", stream: "_PpQZIJsxEe6j6IPBMoyyTQ", component: "_Pp2PAJsxEe6j6IPBMoyyTQ" });
    await expect(t.handler({ pattern: "*.pdf" }, { agentId: "" })).rejects.toThrow(/stream, component are required \(or pass the EWM link/);
  });
});
