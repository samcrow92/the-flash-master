import { describe, expect, it } from "vitest";
import { JazzClient, explain401, parseComments, parseWorkItems, type FetchLike } from "../src/main/jazz";

const AUTH = "x-com-ibm-team-repository-web-auth-msg";
const ITEM = `<workitem><workItem><id>7</id><summary>CAN timeout</summary><description>&lt;p&gt;Bus off&lt;/p&gt;</description>
<state><name>New</name></state><type><name>Defect</name></type><owner><name>Ana</name></owner><projectArea><name>Body</name></projectArea>
<priority><name>High</name></priority><category><name>Comms</name></category><target><name>R1</name></target>
<comments><content>First look</content><creator><name>Bo</name></creator><creationDate>2026-11-01</creationDate></comments>
<comments><content>&lt;b&gt;Fixed&lt;/b&gt; in dev</content><creator><name>Ana</name></creator><creationDate>2026-11-02</creationDate></comments>
</workItem><workItem><id>8</id><summary>Flash driver</summary><description>NVM</description><state><name>Done</name></state><type><name>Task</name></type></workItem></workitem>`;

type Resp = { status?: number; headers?: Record<string, string | undefined>; body?: string; url?: string };
const fake = (handler: (url: string, init: any, n: number) => Resp) => {
  const calls: { url: string; init: any }[] = [];
  const f: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const r = handler(url, init ?? {}, calls.length);
    const h = new Map(Object.entries(r.headers ?? {}).filter(([, v]) => v !== undefined).map(([k, v]) => [k.toLowerCase(), v!]));
    const status = r.status ?? 200;
    return { status, ok: status < 400, url: r.url ?? url, headers: { get: (n) => h.get(n.toLowerCase()) ?? null }, text: async () => r.body ?? ITEM };
  };
  return { f, calls };
};
const base = { serverUrl: "https://j/ccm", projectAreas: ["Body", "Powertrain"], username: "u", password: "p" };

describe("Jazz client", () => {
  it("parses rich fields and comments", () => {
    const [w, t] = parseWorkItems(ITEM, "https://j/ccm");
    expect(w).toMatchObject({ id: "7", title: "CAN timeout", description: "Bus off", projectArea: "Body", priority: "High", category: "Comms", plannedFor: "R1", owner: "Ana" });
    expect(t!.owner).toBeNull();
    expect(parseComments(ITEM)).toEqual([
      { author: "Bo", date: "2026-11-01", text: "First look" },
      { author: "Ana", date: "2026-11-02", text: "Fixed in dev" },
    ]);
  });

  it("builds structured searches across several project areas", async () => {
    const { f, calls } = fake(() => ({}));
    const j = new JazzClient({ ...base, authType: "basic" }, f);
    await j.search({ state: "closed", type: "Defect", owner: "me" });
    const url = decodeURIComponent(calls[0]!.url);
    expect(url).toContain("(projectArea/name='Body' or projectArea/name='Powertrain')");
    expect(url).toContain("state/group='closed'");
    expect(url).toContain("type/name='Defect'");
    expect(url).toContain("owner/userId='u'");
    await j.search({ projectAreas: ["O'Brien"], state: "all" });
    expect(decodeURIComponent(calls[1]!.url)).toContain("[(projectArea/name='O''Brien')]");
  });

  it("matches words locally and looks up ids directly", async () => {
    const { f, calls } = fake(() => ({}));
    const j = new JazzClient({ ...base, authType: "basic" }, f);
    expect((await j.search({ text: "flash nvm" })).map((w) => w.id)).toEqual(["8"]);
    await j.search({ text: "7, 8" });
    expect(decodeURIComponent(calls[1]!.url)).toContain("[id=7 or id=8]");
  });

  it("re-logs in once when a form session expires (HTTP 401)", async () => {
    let session = 0;
    const { f, calls } = fake((url) => {
      if (url.endsWith("/j_security_check")) { session++; return { headers: { "set-cookie": `JSESSIONID=s${session}` } }; }
      if (url.endsWith("/authenticated/identity")) return session ? {} : { headers: { [AUTH]: "authrequired" } };
      if (url.includes("/rpt/") && session === 1) return { status: 401, headers: { "www-authenticate": "JazzFormAuth" } }; // expired
      return {};
    });
    const items = await new JazzClient({ ...base, authType: "form" }, f).search({});
    expect(items).toHaveLength(2);
    expect(session).toBe(2);
    expect(calls.at(-1)!.init.headers.Cookie).toContain("JSESSIONID=s2");
  });

  it("falls back to Basic when the server asks for it", async () => {
    const { f, calls } = fake((url, init) => {
      if (url.endsWith("/authenticated/identity")) return {};
      return init.headers?.Authorization ? {} : { status: 401, headers: { "www-authenticate": 'Basic realm="jazz"' } };
    });
    const j = new JazzClient({ ...base, authType: "form" }, f);
    expect(await j.get("7")).toMatchObject({ id: "7" });
    expect(calls.at(-1)!.init.headers.Authorization).toBe("Basic " + Buffer.from("u:p").toString("base64"));
  });

  it("explains Windows / token auth instead of a bare 401", async () => {
    const { f } = fake(() => ({ status: 401, headers: { "www-authenticate": "Negotiate" } }));
    await expect(new JazzClient({ ...base, authType: "basic" }, f).get("7")).rejects.toThrow(/Windows \(integrated\)/);
    expect(explain401(401, "Negotiate", "windows")).toMatch(/Windows sign-in was rejected/);
    expect(explain401(401, "jauth realm=x", "form")).toMatch(/Jazz Authorization Server/);
    expect(explain401(401, "Basic", "basic")).toMatch(/password rejected/);
  });

  it("windows auth sends no credentials and resolves 'me' from the identity endpoint", async () => {
    const { f, calls } = fake((url) => (url.endsWith("/authenticated/identity") ? { body: '{"userId":"DOMAIN\\\\ana"}' } : {}));
    const j = new JazzClient({ ...base, authType: "windows", username: "", password: "" }, f);
    expect(await j.whoAmI()).toBe("DOMAIN\\ana");
    await j.search({ owner: "me" });
    expect(calls.every((c) => !c.init.headers.Authorization)).toBe(true);
  });

  it("lists project areas and loads details with comments", async () => {
    const areas = `<jp:project-areas xmlns:jp="x"><jp:project-area jp:name="Powertrain" /><jp:project-area jp:name="Body &amp; Chassis"/></jp:project-areas>`;
    const { f } = fake((url) => (url.endsWith("/process/project-areas") ? { body: areas } : {}));
    const j = new JazzClient({ ...base, authType: "basic" }, f);
    expect(await j.listProjectAreas()).toEqual(["Body & Chassis", "Powertrain"]);
    const d = await j.detail("7");
    expect(d.item.id).toBe("7");
    expect(d.comments).toHaveLength(2);
  });
});

describe("Jazz browser sign-in (SSO / Jazz Authorization Server)", () => {
  it("sends no credentials or manual cookies and asks for sign-in on 401", async () => {
    const { f, calls } = fake(() => ({ status: 401, headers: { "www-authenticate": 'Bearer realm="jazz"', "set-cookie": "X=1" } }));
    const j = new JazzClient({ ...base, authType: "browser", username: "", password: "" }, f);
    await expect(j.get("7")).rejects.toMatchObject({ code: "JAZZ_SIGNIN" });
    await expect(j.get("7")).rejects.toThrow(/Sign in to Jazz/);
    expect(calls.every((c) => !c.init.headers.Authorization && !c.init.headers.Cookie)).toBe(true);
  });

  it("works with the session cookies once signed in", async () => {
    const { f } = fake(() => ({}));
    expect(await new JazzClient({ ...base, authType: "browser", username: "", password: "" }, f).search({ state: "all" })).toHaveLength(2);
  });

  it("points Bearer servers to browser sign-in", () => {
    expect(explain401(401, "Bearer", "basic")).toMatch(/Browser sign-in \(SSO\)/);
  });
});

describe("Jazz query fallbacks", () => {
  it("retries with simpler queries when the server rejects fields or filters, and remembers what works", async () => {
    const { f, calls } = fake((url) => {
      const u = decodeURIComponent(url);
      if (u.includes("state/group") || u.includes("priority/name")) return { status: 500, body: "<error><message>CRJAZ1234E Unknown attribute 'group'</message></error>" };
      return {};
    });
    const j = new JazzClient({ ...base, authType: "basic" }, f);
    const open = await j.search({ state: "open" });
    expect(open.map((w) => w.id)).toEqual(["7"]); // "Done" item 8 filtered out locally
    const closed = await j.search({ state: "closed" });
    expect(closed.map((w) => w.id)).toEqual(["8"]);
    const n = calls.length;
    await j.search({ state: "open" });
    expect(calls.length - n).toBe(1); // goes straight to the working shape
  });

  it("surfaces the server's own error message", async () => {
    const { f } = fake(() => ({ status: 500, body: "<html><body><h1>Error</h1><message>CRJAZ0001E Query too complex</message></body></html>" }));
    await expect(new JazzClient({ ...base, authType: "basic" }, f).search({})).rejects.toThrow(/HTTP 500 — CRJAZ0001E Query too complex/);
  });

  it("detail falls back to basic fields and fetches comments separately", async () => {
    const { f } = fake((url) => (decodeURIComponent(url).includes("category/name") ? { status: 500, body: "bad field" } : {}));
    const d = await new JazzClient({ ...base, authType: "basic" }, f).detail("7");
    expect(d.item.id).toBe("7");
    expect(d.comments).toHaveLength(2);
  });
});
