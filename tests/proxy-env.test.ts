import { readFileSync } from "node:fs";
import { describe as d, expect, it } from "vitest";
import { buildProxyUrl, currentProxyEnv, normaliseProxyAddress, setProxyEnv, validateProxyInput } from "../src/main/win-env";
import { parseProxy } from "../src/main/proxy";

const ok = { address: "dc3proxy01.corp.example:3128", username: "DOMAIN\\jane", password: "p@ss:w/rd%#" };

d("proxy setup form", () => {
  it("normalises the address to host:port", () => {
    expect(normaliseProxyAddress("dc3proxy01.corp.example:3128")).toBe("dc3proxy01.corp.example:3128");
    expect(normaliseProxyAddress("  http://Proxy.Corp:8080/ ")).toBe("proxy.corp:8080");
    expect(normaliseProxyAddress("10.0.0.1:3128")).toBe("10.0.0.1:3128");
    for (const bad of ["proxy.corp", "proxy:0", "proxy:70000", "socks5://proxy:1080", "proxy :80", "http://", ""]) expect(normaliseProxyAddress(bad)).toBeNull();
  });

  it("validates every field", () => {
    expect(validateProxyInput(ok)).toEqual({});
    expect(Object.keys(validateProxyInput({ address: "", username: "", password: "" })).sort()).toEqual(["address", "password", "username"]);
    expect(validateProxyInput({ ...ok, address: "user:pw@proxy:80" }).address).toMatch(/own fields/);
    expect(validateProxyInput({ ...ok, username: "a b" }).username).toBeTruthy();
  });

  it("builds http://user:pass@host:port with special characters encoded", () => {
    const url = buildProxyUrl(ok);
    expect(url).toBe("http://DOMAIN%5Cjane:p%40ss%3Aw%2Frd%25%23@dc3proxy01.corp.example:3128");
    expect(buildProxyUrl({ ...ok, password: "a!b'(c)*" })).toContain(":a%21b%27%28c%29%2A@");
    // The app's own proxy parser reads the credentials back unchanged.
    expect(parseProxy(url)!.credentials).toEqual({ username: ok.username, password: ok.password });
  });

  it("prefills from the environment without the password", () => {
    expect(currentProxyEnv({ HTTPS_PROXY: "http://DOMAIN%5Cjane:secret@proxy:3128" })).toEqual({ address: "proxy:3128", username: "DOMAIN\\jane", set: true });
    expect(currentProxyEnv({})).toEqual({ address: "", username: "", set: false });
  });
});

d("setProxyEnv", () => {
  it("writes HTTP_PROXY and HTTPS_PROXY for the Windows user, passing the value only through the child environment", async () => {
    const calls: { script: string; value?: string }[] = [];
    const env: NodeJS.ProcessEnv = {};
    const r = await setProxyEnv(ok, { platform: "win32", env, run: async (script, e) => { calls.push({ script, value: e.FLASH_PROXY_VALUE }); } });
    expect(r.ok).toBe(true);
    const url = buildProxyUrl(ok);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.value).toBe(url);
    expect(calls[0]!.script).toContain("SetEnvironmentVariable($n,$v,'User')");
    expect(calls[0]!.script).toMatch(/'HTTP_PROXY','HTTPS_PROXY'/);
    expect(calls[0]!.script).not.toContain("jane");
    expect(env.HTTP_PROXY).toBe(url);
    expect(env.HTTPS_PROXY).toBe(url);
    expect(r.display).not.toContain("p%40ss");
    expect(r.detail).not.toContain("p%40ss");
  });

  it("keeps the password out of error messages", async () => {
    const url = buildProxyUrl(ok);
    const r = await setProxyEnv(ok, { platform: "win32", env: {}, run: async () => { throw new Error(`boom ${url}`); } });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("boom");
    expect(r.detail).not.toContain("p%40ss");
  });

  it("refuses invalid input and other platforms without running anything", async () => {
    let ran = false;
    const run = async () => { ran = true; };
    expect((await setProxyEnv({ ...ok, password: "" }, { platform: "win32", env: {}, run })).errors?.password).toBeTruthy();
    expect((await setProxyEnv(ok, { platform: "linux", env: {}, run })).ok).toBe(false);
    expect(ran).toBe(false);
  });

  it("the IPC handler logs only the redacted value", () => {
    const src = readFileSync("src/main/index.ts", "utf8");
    const handler = src.slice(src.indexOf("proxyEnvSet: async"), src.indexOf("proxyEnvSet: async") + 400);
    expect(handler).toMatch(/log\([^\n]*r\.display/);
    expect(handler).not.toMatch(/log\([^\n]*(input|password)/);
  });
});
