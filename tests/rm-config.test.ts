import { describe, expect, it } from "vitest";
import { configUri, isGcWebLink } from "../src/shared/rm-config";
import { parseRmLink } from "../src/main/requirements";

const GC = "https://alm.hella.com/gc/configuration/51068";

describe("configUri", () => {
  it("extracts the configuration from a GCM web link", () => {
    expect(configUri("https://alm.hella.com/gc/web/projects/E-LE%20ASM_HDLP_LED_ECU%20%28GC%29#action=gc.viewConfiguration&path=https%3A%2F%2Falm.hella.com%2Fgc%2Fconfiguration%2F51068")).toBe(GC);
  });
  it("decodes a URL-encoded configuration", () => { expect(configUri("https%3A%2F%2Falm.hella.com%2Fgc%2Fconfiguration%2F51068")).toBe(GC); });
  it("keeps plain configuration URIs and strips query/hash", () => {
    expect(configUri(` ${GC} `)).toBe(GC);
    expect(configUri("https://alm/rm/cm/stream/_abc?x=1")).toBe("https://alm/rm/cm/stream/_abc");
  });
  it("reads oslc_config.context from a DOORS Next link", () => {
    expect(configUri("https://alm/rm/web#action=x&oslc_config.context=https%3A%2F%2Falm%2Frm%2Fcm%2Fbaseline%2F_b1")).toBe("https://alm/rm/cm/baseline/_b1");
  });
  it("leaves other values alone", () => { expect(configUri("")).toBe(""); expect(configUri("not a url")).toBe("not a url"); });
  it("detects GCM links and parseRmLink uses the configuration", () => {
    expect(isGcWebLink("https://alm/gc/web/projects/x")).toBe(true);
    expect(isGcWebLink("https://alm/rmA1/web")).toBe(false);
    expect(parseRmLink(`https://alm.hella.com/gc/web/projects/X#action=gc.viewConfiguration&path=${encodeURIComponent(GC)}`).config).toBe(GC);
  });
});
