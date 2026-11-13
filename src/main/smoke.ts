/**
 * Smoke / demo driver (CI + docs screenshots). Enabled only by env vars:
 *   FLASH_SMOKE_SHOT=<file.png>   boot, screenshot, exit 0 when the UI rendered
 *   FLASH_SMOKE_DEMO=<dir>        additionally drive a full demo (project, streaming chat, thread, reactions,
 *                                 views) through the real UI with the mock harness, saving <dir>/<n>-<view>.png
 */
import { app, type BrowserWindow } from "electron";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runSmoke(win: BrowserWindow, log: (l: "info" | "error", m: string) => void): Promise<void> {
  const js = <T = unknown>(code: string) => win.webContents.executeJavaScript(code) as Promise<T>;
  const shot = async (file: string) => writeFileSync(file, (await win.webContents.capturePage()).toPNG());
  const click = (text: string, sel = "button") =>
    js(`(()=>{const b=[...document.querySelectorAll(${JSON.stringify(sel)})].find(x=>x.textContent.includes(${JSON.stringify(text)}));if(b){b.click();return true}return false})()`);
  try {
    await sleep(Number(process.env.FLASH_SMOKE_DELAY ?? 2500));
    const ok = await js<boolean>("!!document.querySelector('.sidebar')");
    if (process.env.FLASH_SMOKE_SHOT) await shot(process.env.FLASH_SMOKE_SHOT);
    const demo = process.env.FLASH_SMOKE_DEMO;
    if (ok && demo) {
      const proj = process.env.FLASH_SMOKE_PROJECT ?? app.getPath("temp");
      await js(`window.flash.api.updateSettings({ general: { defaultHarness: "mock" } })`);
      await js(`window.flash.api.createProject(${JSON.stringify(proj)}, "brake-ecu")`);
      win.webContents.reload();
      await sleep(2000);
      await click("brake-ecu", ".project-name");
      await sleep(300);
      await click("General", ".chat-link");
      await sleep(500);
      const send = async (text: string, sel = ".chat .composer2 textarea") => {
        await js(`(()=>{const t=document.querySelector(${JSON.stringify(sel)});const set=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;set.call(t,${JSON.stringify(text)});t.dispatchEvent(new Event('input',{bubbles:true}));t.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));})()`);
      };
      await send("Analyse the brake light feature: which SWCs and CAN signals are involved, and what should we test?");
      await sleep(900);
      await shot(join(demo, "1-streaming.png"));
      await sleep(4500);
      await js(`[...document.querySelectorAll('.msg-agent .msg-actions button')].find(b=>b.title==='Reply in thread')?.click()`);
      await sleep(500);
      await send("@reviewer double-check the signal scaling", ".thread .composer2 textarea");
      await sleep(5500);
      await js(`(async()=>{const st=window.flash.api;const chats=await st.listChats((await st.listProjects())[0].id);const msgs=await st.listMessages(chats[0].id,null);const a=msgs.find(m=>m.author==='agent');if(a){await st.toggleReaction(a.id,'👍');await st.toggleReaction(a.id,'🚀');}})()`);
      await sleep(600);
      await shot(join(demo, "2-chat-thread-reactions.png"));
      await click("Progress", ".chat-controls button");
      await sleep(900);
      await shot(join(demo, "2b-progress-flow.png"));
      await click("Progress", ".chat-controls button");
      await sleep(300);
      await send("@rca-analyst Analyse the brake light flicker in NOW format with an Ishikawa root cause analysis");
      await sleep(1500);
      await click("Progress", ".chat-controls button");
      await sleep(400);
      await shot(join(demo, "2c-progress-live.png"));
      await click("Progress", ".chat-controls button");
      await sleep(8000);
      await js(`(()=>{const l=document.querySelector('.chat .messages');l.scrollTop=l.scrollHeight})()`);
      await sleep(500);
      await shot(join(demo, "2d-rca-ishikawa.png"));
      await js(`[...document.querySelectorAll('.section-title button')].find(b=>b.title.startsWith('Add your own agent'))?.click()`);
      await sleep(1200);
      await shot(join(demo, "2e-import-agent.png"));
      await js(`document.querySelector('.modal-back')?.click()`);
      await sleep(300);
      await js(`(async()=>window.flash.api.createTask({ title: "Verify BrakeLightReq timing on HIL", priority: 1, assigneeRole: "tester", status: "todo", projectId: (await window.flash.api.listProjects())[0]?.id ?? null }))()`);
      await js(`(async()=>window.flash.api.createTask({ title: "Review CAPL test module for brake light", priority: 2, assigneeRole: "autosar-vector", status: "in_progress", jazzId: "48213", projectId: (await window.flash.api.listProjects())[0]?.id ?? null }))()`);
      for (const [label, name] of [["Agents", "3-agents"], ["Dashboard", "4-dashboard"], ["Tasks", "5-tasks"], ["Settings", "6-settings"]] as const) {
        await click(label, ".sidebar button");
        await sleep(1200);
        await shot(join(demo, `${name}.png`));
      }
      const mpUrl = process.env.FLASH_SMOKE_MARKET_URL;
      if (mpUrl) {
        await js(`window.flash.api.updateSettings({ marketplace: { sources: [{ id: "body", name: "Body Electronics", department: "Body", url: ${JSON.stringify(mpUrl)}, enabled: true }] } }).then(s=>{})`);
        win.webContents.reload();
        await sleep(2500);
        await click("Marketplace", ".sidebar button");
        await sleep(1500);
        await js(`[...document.querySelectorAll('.mp-card button.primary')][0]?.click()`);
        await sleep(1500);
        await js(`document.querySelector('.mp-card')?.click()`);
        await sleep(600);
        await shot(join(demo, "9-marketplace.png"));
        await click("Settings", ".sidebar button");
        await sleep(600);
        await click("Marketplace", ".tabs button");
        await sleep(600);
        await shot(join(demo, "9b-settings-marketplace.png"));
        await js(`document.querySelector('.theme-toggle')?.click()`);
        await sleep(800);
        await click("Marketplace", ".sidebar button");
        await sleep(1200);
        await shot(join(demo, "9c-light-marketplace.png"));
        await js(`(async()=>{const p=(await window.flash.api.listProjects())[0];const c=(await window.flash.api.listChats(p.id))[0];return c.id})()`).then(() => undefined);
        await click("brake-ecu", ".project-name");
        await sleep(300);
        await click("General", ".chat-link");
        await sleep(1200);
        await shot(join(demo, "9d-light-chat.png"));
        await js(`document.querySelector('.theme-toggle')?.click()`);
        await sleep(400);
        await click("Settings", ".sidebar button");
        await sleep(600);
      }
      // New UI: right-click menu, context reset divider, documentation
      if (!(await js<boolean>(`!!document.querySelector('.chat-link')`))) await click("brake-ecu", ".project-name");
      await sleep(200);
      await js(`(()=>{const el=[...document.querySelectorAll('.chat-link')].find(e=>e.textContent.includes('General'));el?.click();})()`);
      await sleep(800);
      await js(`(()=>{const b=document.querySelector('.reset-ctx');b&&!b.disabled&&b.click();})()`);
      await sleep(900);
      await js(`(()=>{const el=document.querySelector('.chat-link.active')||document.querySelector('.chat-link');if(!el)return;const r=el.getBoundingClientRect();el.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:r.left+60,clientY:r.top+10}));})()`);
      await sleep(400);
      await shot(join(demo, "14-context-menu-reset.png"));
      await js(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))`);
      await sleep(200);
      await click("Documentation", ".sidebar button");
      await sleep(1500);
      await shot(join(demo, "15-docs-start.png"));
      await click("Install Copilot CLI", ".docs-nav button");
      await sleep(700);
      await shot(join(demo, "16-docs-install.png"));
      await click("Sign in to Copilot", ".docs-nav button");
      await sleep(700);
      await shot(join(demo, "17-docs-login.png"));
      await click("Using TheFlashMaster", ".docs-nav button");
      await sleep(700);
      await shot(join(demo, "18-docs-use.png"));
      // Profile: initials first, then a generated picture
      await click("Settings", ".sidebar button");
      await sleep(400);
      await click("General", ".tabs button");
      await js(`window.flash.api.updateSettings({ profile: { name: "Ana Pop", hue: 320 } }).then(()=>{})`);
      win.webContents.reload();
      await sleep(2200);
      await click("Settings", ".sidebar button");
      await sleep(400);
      await shot(join(demo, "19-profile-initials.png"));
      await js(`(()=>{const c=document.createElement('canvas');c.width=c.height=192;const g=c.getContext('2d');const gr=g.createLinearGradient(0,0,192,192);gr.addColorStop(0,'#ff9a3c');gr.addColorStop(1,'#6a4cff');g.fillStyle=gr;g.fillRect(0,0,192,192);g.fillStyle='rgba(255,255,255,.9)';g.beginPath();g.arc(96,76,34,0,7);g.fill();g.beginPath();g.ellipse(96,178,62,52,0,0,7);g.fill();return window.flash.api.updateSettings({ profile: { avatar: c.toDataURL('image/webp',.86) } }).then(()=>true)})()`);
      win.webContents.reload();
      await sleep(2200);
      await click("Settings", ".sidebar button");
      await sleep(500);
      await shot(join(demo, "20-profile-picture.png"));
      const rmBase = process.env.FLASH_SMOKE_RM_URL;
      if (rmBase) {
        await js(`window.flash.api.updateSettings({ jazz: { enabled: true, serverUrl: ${JSON.stringify(rmBase + "/ccm")}, authType: "basic", username: "ana", rm: { enabled: true } } }).then(()=>{})`);
        win.webContents.reload();
        await sleep(2200);
        await click("Jazz", ".sidebar button");
        await sleep(600);
        await click("Requirements", ".jazz-tabs button");
        await sleep(1500);
        await js(`document.querySelector('.rm-module')?.click()`);
        await sleep(1200);
        await shot(join(demo, "21-requirements-module.png"));
        await js(`(()=>{const i=document.querySelector('.search-box input');const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;set.call(i,'brake light flicker supply voltage');i.dispatchEvent(new Event('input',{bubbles:true}));i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));})()`);
        await sleep(900);
        await js(`[...document.querySelectorAll('.rm-req input')].slice(0,2).forEach(c=>c.click())`);
        await sleep(300);
        await js(`document.querySelector('.rm-req-body')?.click()`);
        await sleep(600);
        await shot(join(demo, "22-requirements-search.png"));
        await click("Settings", ".sidebar button");
        await sleep(400);
        await click("Integrations", ".tabs button");
        await sleep(500);
        await js(`document.querySelector('.tab-body')?.scrollTo(0, 99999); document.querySelector('.settings')?.scrollTo?.(0,99999)`);
        await sleep(300);
        await shot(join(demo, "23-settings-rm.png"));
      }
      const ssoUrl = process.env.FLASH_SMOKE_JAZZ_SSO_URL;
      if (ssoUrl) {
        await js(`window.flash.api.updateSettings({ jazz: { enabled: true, serverUrl: ${JSON.stringify(ssoUrl)}, authType: "browser" } }).then(()=>{})`);
        const before = await js<string>(`window.flash.api.jazzTest().then(r=>JSON.stringify(r))`);
        const signIn = await js<string>(`window.flash.api.jazzSignIn().then(r=>JSON.stringify(r))`);
        const after = await js<string>(`window.flash.api.jazzSearch({state:"all"}).then(r=>JSON.stringify(r.map(w=>w.title))).catch(e=>String(e))`);
        log("info", `smoke-sso before=${before} signIn=${signIn} after=${after}`);
      }
      const jazzUrl = process.env.FLASH_SMOKE_JAZZ_URL;
      if (jazzUrl) {
        await js(`window.flash.api.updateSettings({ jazz: { enabled: true, serverUrl: ${JSON.stringify(jazzUrl)}, authType: "basic", username: "ana", projectAreas: ["Body Electronics", "Powertrain"] } }).then(()=>{})`);
        win.webContents.reload();
        await sleep(2500);
        await click("brake-ecu", ".project-name");
        await sleep(300);
        await click("General", ".chat-link");
        await sleep(1000);
        await shot(join(demo, "10-usage-meter.png"));
        await click("Jazz", ".sidebar button");
        await sleep(1500);
        await js(`document.querySelector('.jazz-item')?.click()`);
        await sleep(1200);
        await shot(join(demo, "11-jazz-workspace.png"));
        await click("Settings", ".sidebar button");
        await sleep(500);
        await click("Usage", ".tabs button");
        await sleep(500);
        await shot(join(demo, "12-settings-usage.png"));
        await click("Integrations", ".tabs button");
        await sleep(500);
        await shot(join(demo, "13-settings-jazz.png"));
      }
      await click("Token efficiency", ".tabs button");
      await sleep(400);
      await shot(join(demo, "7-settings-tokens.png"));
      await click("MCP servers", ".tabs button");
      await sleep(400);
      await shot(join(demo, "8-settings-mcp.png"));
    }
    log("info", `smoke: ui=${ok}`);
    app.exit(ok ? 0 : 1);
  } catch (e) {
    log("error", `smoke failed: ${String(e)}`);
    app.exit(2);
  }
}
