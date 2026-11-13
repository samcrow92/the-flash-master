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
      const send = async (text: string, sel = ".chat .composer textarea") => {
        await js(`(()=>{const t=document.querySelector(${JSON.stringify(sel)});const set=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;set.call(t,${JSON.stringify(text)});t.dispatchEvent(new Event('input',{bubbles:true}));t.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));})()`);
      };
      await send("Analyse the brake light feature: which SWCs and CAN signals are involved, and what should we test?");
      await sleep(900);
      await shot(join(demo, "1-streaming.png"));
      await sleep(4500);
      await js(`[...document.querySelectorAll('.msg-agent .msg-actions button')].find(b=>b.title==='Reply in thread')?.click()`);
      await sleep(500);
      await send("@reviewer double-check the signal scaling", ".thread .composer textarea");
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
