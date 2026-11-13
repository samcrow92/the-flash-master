import { describe as d, expect, it } from "vitest";
import { cliProxyUrl, explainProxyError, fallbacks, isProxySetupError, parseProxy, redact } from "../src/main/proxy";

d("parseProxy", () => {
  it("returns null for empty", () => { expect(parseProxy("")).toBeNull(); expect(parseProxy("  ")).toBeNull(); });

  it("strips http(s) scheme, path and trailing slash", () => {
    expect(parseProxy("http://proxy.corp:8080/")!.config).toEqual({ mode: "fixed_servers", proxyRules: "proxy.corp:8080", proxyBypassRules: "" });
    expect(parseProxy("https://proxy.corp:8080/some/path?x=1")!.config.proxyRules).toBe("proxy.corp:8080");
    expect(parseProxy("proxy.corp:3128", "<local>")!.config.proxyBypassRules).toBe("<local>");
  });

  it("moves credentials out of the rules", () => {
    const p = parseProxy("http://DOMAIN%5Cjohn:p%40ss@proxy:8080")!;
    expect(p.config.proxyRules).toBe("proxy:8080");
    expect(p.credentials).toEqual({ username: "DOMAIN\\john", password: "p@ss" });
    expect(p.display).not.toContain("p%40ss");
  });

  it("maps socks variants Chromium does not know", () => {
    const p = parseProxy("socks5h://127.0.0.1:1080")!;
    expect(p.config.proxyRules).toBe("socks5://127.0.0.1:1080");
    expect(p.warnings.length).toBe(1);
    expect(parseProxy("socks4a://h:1")!.config.proxyRules).toBe("socks4://h:1");
  });

  it("recognises PAC / WPAD URLs", () => {
    expect(parseProxy("http://wpad.corp/wpad.dat")!.config).toEqual({ mode: "pac_script", pacScript: "http://wpad.corp/wpad.dat" });
    expect(parseProxy("https://it.corp/proxy.pac")!.config.mode).toBe("pac_script");
    expect(parseProxy("pac:http://x/y")!.config.pacScript).toBe("http://x/y");
    expect(parseProxy("pac+https://x/cfg")!.config.pacScript).toBe("https://x/cfg");
  });

  it("keeps multiple entries in order and drops unusable ones", () => {
    const p = parseProxy("http://a:1, ftp://b:2; c:3")!;
    expect(p.config.proxyRules).toBe("a:1,c:3");
    expect(p.warnings.some((w) => w.includes("ftp"))).toBe(true);
  });

  it("normalises Chromium per-scheme syntax", () => {
    expect(parseProxy("http=http://a:1;https=user:pw@b:2")!.config.proxyRules).toBe("http=a:1;https=b:2");
  });

  it("falls back to the system proxy when nothing is usable", () => {
    const p = parseProxy("gopher://x:1")!;
    expect(p.config.mode).toBe("system");
    expect(p.warnings.length).toBeGreaterThan(0);
  });
});

d("fallbacks and errors", () => {
  it("orders fallbacks", () => {
    expect(fallbacks({ mode: "fixed_servers", proxyRules: "a:1" }).map((c) => c.mode)).toEqual(["system", "direct"]);
    expect(fallbacks({ mode: "system" }).map((c) => c.mode)).toEqual(["auto_detect", "direct"]);
    expect(fallbacks({ mode: "direct" })).toEqual([]);
  });
  it("detects proxy setup errors", () => {
    expect(isProxySetupError(new Error("net::ERR_NO_SUPPORTED_PROXIES"))).toBe(true);
    expect(isProxySetupError("net::ERR_PROXY_CONNECTION_FAILED")).toBe(true);
    expect(isProxySetupError(new Error("net::ERR_NAME_NOT_RESOLVED"))).toBe(false);
  });
  it("explains ERR_NO_SUPPORTED_PROXIES", () => {
    expect(explainProxyError(new Error("net::ERR_NO_SUPPORTED_PROXIES"), "QUIC x:443")).toMatch(/Settings → Network/);
  });
  it("redacts passwords", () => { expect(redact("http://u:secret@h:1")).toBe("http://u:***@h:1"); });
});

d("cliProxyUrl", () => {
  it("builds a URL for command-line tools", () => {
    expect(cliProxyUrl("proxy:8080")).toBe("http://proxy:8080");
    expect(cliProxyUrl("http://u:p@w@proxy:8080/")).toBe("http://u:p%40w@proxy:8080");
    expect(cliProxyUrl("socks5h://h:1080")).toBe("socks5://h:1080");
    expect(cliProxyUrl("http://wpad/wpad.dat")).toBe("");
    expect(cliProxyUrl("")).toBe("");
  });
});
