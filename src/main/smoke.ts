/**
 * Smoke / demo driver (CI + docs screenshots). Enabled only by env vars:
 *   FLASH_SMOKE_SHOT=<file.png>   boot, screenshot, exit 0 when the UI rendered
 *   FLASH_SMOKE_DEMO=<dir>        additionally drive a full demo (project, streaming chat, thread, reactions,
 *                                 views) through the real UI with the mock harness, saving <dir>/<n>-<view>.png
 *   FLASH_SMOKE_ASK=<dir>         only the "needs you" cards (a question, a specialist that delivered nothing), dark and light
 *   FLASH_SMOKE_IMAGES=<dir>      only images in chats: a pasted picture, an agent screenshot (inline + tool call), the viewer
 *   FLASH_SMOKE_GRAPH=<dir>       only the knowledge base's code graph: Scan code with the real graphify on FLASH_SMOKE_PROJECT
 *   FLASH_SMOKE_SERVER=<dir>      only the Flash server features (settings, marketplace, submit, my submissions, updates) against
 *                                 a built-in stub server (smoke-server.ts); FLASH_SMOKE_PICK = the folder the Submit dialog "picks"
 */
import { app, BrowserWindow, type NativeImage } from "electron";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Orchestrator } from "./orchestrator";
import type { Db } from "./db";
import { startStubServer, STUB_TOKEN } from "./smoke-server";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runSmoke(win: BrowserWindow, log: (l: "info" | "error", m: string) => void, icon?: NativeImage & { file: string },
  hooks?: { orch: Orchestrator; db: Db }): Promise<void> {
  const js = <T = unknown>(code: string) => win.webContents.executeJavaScript(code) as Promise<T>;
  const shot = async (file: string) => writeFileSync(file, (await win.webContents.capturePage()).toPNG());
  const click = (text: string, sel = "button") =>
    js(`(()=>{const b=[...document.querySelectorAll(${JSON.stringify(sel)})].find(x=>x.textContent.includes(${JSON.stringify(text)}));if(b){b.click();return true}return false})()`);
  try {
    await sleep(Number(process.env.FLASH_SMOKE_DELAY ?? 2500));
    const ok = await js<boolean>("!!document.querySelector('.sidebar')");
    if (process.env.FLASH_SMOKE_SHOT) await shot(process.env.FLASH_SMOKE_SHOT);
    const askDir = process.env.FLASH_SMOKE_ASK;
    if (ok && askDir && hooks) {
      mkdirSync(askDir, { recursive: true });
      const proj = process.env.FLASH_SMOKE_PROJECT ?? app.getPath("temp");
      await js(`window.flash.api.updateSettings({ general: { defaultHarness: "mock" } })`);
      await js(`window.flash.api.createProject(${JSON.stringify(proj)}, "brake-ecu")`);
      win.webContents.reload();
      await sleep(2000);
      await click("brake-ecu", ".project-name");
      await sleep(300);
      await click("General", ".chat-link");
      await sleep(500);
      await js(`(()=>{const t=document.querySelector('.chat > .composer-wrap .composer2 textarea');const set=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;set.call(t,'Calibrate the brake model for the cold start [needs-decision]');t.dispatchEvent(new Event('input',{bubbles:true}));t.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));})()`);
      await sleep(5000);
      // A specialist that never delivers: reminded, restarted, then put to the user as a card.
      const coord = hooks.db.listAgents().find((a) => a.role === "flashmaster");
      if (coord) await hooks.orch.delegate(coord.id, { role: "tester", goal: "Check the CAN logs of the cold-start run [silent-always]", wait: false });
      await sleep(6000);
      const bottom = () => js(`(()=>{const l=document.querySelector('.chat .msg-list, .chat .messages, .chat-scroll');if(l)l.scrollTop=l.scrollHeight;document.querySelectorAll('.ask-card')[document.querySelectorAll('.ask-card').length-1]?.scrollIntoView({block:'end'})})()`);
      await bottom();
      await sleep(400);
      await shot(join(askDir, "needs-you-cards-dark.png"));
      await js(`document.querySelector('.ask-card .ask-opt.rec')?.click()`);
      await sleep(1500);
      await js(`document.querySelector('.ask-card.answered')?.scrollIntoView({block:'start'})`);
      await sleep(400);
      await shot(join(askDir, "needs-you-answered-dark.png"));
      // The recovery attempts, as they show in the specialist's thread.
      await js(`document.querySelector('.thread-pill')?.click()`);
      await sleep(900);
      await js(`[...document.querySelectorAll('.inline-thread.open .sys-line')].find(x=>x.textContent.includes('recovery'))?.scrollIntoView({block:'center'})`);
      await sleep(400);
      await shot(join(askDir, "recovery-thread-dark.png"));
      await js(`document.querySelector('.thread-pill.open')?.click()`);
      await js(`window.flash.api.updateSettings({ general: { theme: "light" } })`);
      win.webContents.reload();
      await sleep(2500);
      await click("brake-ecu", ".project-name");
      await sleep(300);
      await click("General", ".chat-link");
      await sleep(800);
      await bottom();
      await sleep(600);
      await shot(join(askDir, "needs-you-cards-light.png"));
      log("info", `smoke-ask: cards=${await js<number>("document.querySelectorAll('.ask-card').length")}`);
      app.exit(0);
      return;
    }
    const imgDir = process.env.FLASH_SMOKE_IMAGES;
    if (ok && imgDir) {
      mkdirSync(imgDir, { recursive: true });
      const proj = process.env.FLASH_SMOKE_PROJECT ?? app.getPath("temp");
      await js(`window.flash.api.updateSettings({ general: { defaultHarness: "mock" } })`);
      await js(`window.flash.api.createProject(${JSON.stringify(proj)}, "brake-ecu")`);
      win.webContents.reload();
      await sleep(2000);
      await click("brake-ecu", ".project-name");
      await sleep(300);
      await click("General", ".chat-link");
      await sleep(600);
      // A picture the user pasted (drawn on a canvas), sent with a request that makes the mock agent take a "screenshot".
      await js(`(async()=>{const st=document.querySelector('[data-chat]');const chatId=st.dataset.chat;const c=document.createElement('canvas');c.width=640;c.height=360;const g=c.getContext('2d');const gr=g.createLinearGradient(0,0,640,360);gr.addColorStop(0,'#1d3b6a');gr.addColorStop(1,'#5b2b6e');g.fillStyle=gr;g.fillRect(0,0,640,360);g.strokeStyle='#ffb347';g.lineWidth=5;g.beginPath();for(let x=0;x<=640;x+=8){const y=190-70*Math.sin(x/60)*Math.exp(-x/500);x?g.lineTo(x,y):g.moveTo(x,y)}g.stroke();g.fillStyle='rgba(255,255,255,.85)';g.font='bold 26px sans-serif';g.fillText('Brake lamp current, -20 °C',24,44);const a=await window.flash.api.saveAttachment({chatId,name:'scope-capture.png',mime:'image/png',dataBase64:c.toDataURL('image/png').split(',')[1]});await window.flash.api.sendMessage({chatId,content:'The lamp flickers on this scope capture. Take a screenshot of the cold-start dashboard.',attachments:[a]});})()`);
      await sleep(7000);
      const imgs = await js<number>(`document.querySelectorAll('.md-img[src], .chat-img img, .msg-att.img img').length`);
      await js(`(()=>{const l=document.querySelector('.chat .msg-list, .chat .messages, .chat-scroll');if(l)l.scrollTop=l.scrollHeight;document.querySelector('.md-img[src]')?.scrollIntoView({block:'center'})})()`);
      await sleep(500);
      await shot(join(imgDir, "chat-images-dark.png"));
      await js(`document.querySelector('.md-img[src]')?.click()`);
      await sleep(600);
      await shot(join(imgDir, "image-viewer-dark.png"));
      const viewer = await js<boolean>(`!!document.querySelector('.img-viewer img[src^="data:image/png"]')`);
      await js(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
      await js(`window.flash.api.updateSettings({ general: { theme: "light" } })`);
      win.webContents.reload();
      await sleep(2500);
      await click("brake-ecu", ".project-name");
      await sleep(300);
      await click("General", ".chat-link");
      await sleep(1500);
      await js(`document.querySelector('.md-img[src]')?.scrollIntoView({block:'center'})`);
      await sleep(500);
      await shot(join(imgDir, "chat-images-light.png"));
      log(imgs >= 3 && viewer ? "info" : "error", `smoke-images: inline=${imgs} viewer=${viewer}`);
      app.exit(imgs >= 3 && viewer ? 0 : 1);
      return;
    }
    const graphDir = process.env.FLASH_SMOKE_GRAPH;
    if (ok && graphDir) {
      mkdirSync(graphDir, { recursive: true });
      const proj = process.env.FLASH_SMOKE_PROJECT ?? app.getPath("temp");
      await js(`window.flash.api.createProject(${JSON.stringify(proj)}, "flash-master")`);
      // A long memory list, as on a real install: the knowledge panel must keep its size above it.
      await js(`(async()=>{for(let i=1;i<=30;i++) {const w=["brake","lamp","CAN","HIL","DaVinci","CAPL","bootloader","NVM","watchdog","diagnostics"];await window.flash.api.saveMemory({ content: w[i%10]+" "+w[(i*3)%10]+" rule "+i+" "+"xyzqwv".repeat(i%5+1)+": keep "+w[(i*7)%10]+" timing at "+(i*13)+" ms on bench "+(i%4), scope: "user", kind: "fact", tags: [w[i%10].toLowerCase()] });}})()`);
      win.webContents.reload();
      await sleep(2000);
      await click("flash-master", ".project-name");
      await sleep(300);
      const memoryPage = async () => {
        await click("General", ".chat-link"); // opening a project chat makes it the current project, which the Memory page shows
        await sleep(600);
        await click("Memory", ".sidebar button");
        await sleep(1200);
      };
      await memoryPage();
      await shot(join(graphDir, "1-before-scan.png"));
      const geometry = () => js<string>(`[".kb-panel", ".kb-graph", ".memory-scopes", ".kb-actions"].map((s) => { const r = document.querySelector(s)?.getBoundingClientRect(); return s + "=" + (r ? Math.round(r.width) + "x" + Math.round(r.height) : "none"); }).join(" ")`);
      log("info", `smoke-graph layout: ${await geometry()}`);
      await click("Scan code", ".kb-graph button");
      let installShot = false, scanShot = false;
      for (let i = 0; i < 6000 && await js<boolean>("!!document.querySelector('.kb-graph button[disabled]')"); i++) {
        if (!installShot && await js<boolean>("!!document.querySelector('.kb-progress-track.indeterminate')")) {
          await sleep(300); await shot(join(graphDir, "2a-installing.png")); installShot = true;
          log("info", `smoke-graph installing: ${await js<string>("document.querySelector('.kb-graph-line')?.textContent ?? ''")} · ${await geometry()}`);
        }
        if (!scanShot && await js<boolean>("(()=>{const f=document.querySelector('.kb-progress-track:not(.indeterminate) .kb-progress-fill');return !!f && parseFloat(f.style.width) >= 20})()")) {
          await sleep(250); await shot(join(graphDir, "2b-scanning.png")); scanShot = true;
          log("info", `smoke-graph scanning: ${await js<string>("document.querySelector('.kb-graph')?.textContent ?? ''")}`);
        }
        await sleep(100);
      }
      await sleep(800);
      await js(`[...document.querySelectorAll('.seg button')].find(b=>b.textContent.includes('Knowledge base'))?.click()`);
      await sleep(800);
      await shot(join(graphDir, "3-after-scan-dark.png"));
      log("info", `smoke-graph: ${await js<string>("document.querySelector('.kb-graph')?.textContent ?? 'none'")}`);
      await js(`window.flash.api.updateSettings({ general: { theme: "light" } })`);
      win.webContents.reload();
      await sleep(2500);
      await click("flash-master", ".project-name");
      await sleep(300);
      await memoryPage();
      await js(`[...document.querySelectorAll('.seg button')].find(b=>b.textContent.includes('Knowledge base'))?.click()`);
      await sleep(800);
      await shot(join(graphDir, "4-after-scan-light.png"));
      await js(`document.querySelector('.memory-card')?.click()`);
      await sleep(800);
      await shot(join(graphDir, "5-code-map-entry.png"));
      app.exit(0);
      return;
    }
    const serverDir = process.env.FLASH_SMOKE_SERVER;
    if (ok && serverDir) {
      mkdirSync(serverDir, { recursive: true });
      const stub = await startStubServer(join(app.getAppPath(), "marketplace-example"));
      const setVal = (sel: string, v: string) => js(`(()=>{const el=document.querySelector(${JSON.stringify(sel)});if(!el)return false;const proto=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(el,${JSON.stringify(v)});el.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
      const step = async (name: string) => { await shot(join(serverDir, `${name}.png`)); log("info", `smoke-server: ${name}`); };
      await js(`window.flash.api.updateSettings({ server: { url: ${JSON.stringify(stub.url)} } })`);
      const tok = await js<string>(`window.flash.api.serverSetToken(${JSON.stringify(STUB_TOKEN)}).then(() => "ok", (e) => String(e?.message ?? e))`);
      log("info", `smoke-server: stub ${stub.url}, token ${tok}`);
      win.webContents.reload();
      await sleep(2500);
      await click("Settings", ".sidebar button");
      await sleep(600);
      await click("Flash server", ".tabs button");
      await sleep(400);
      await click("Test connection");
      await sleep(1200);
      await step("app-settings-server");
      await click("Marketplace", ".sidebar button");
      await sleep(2500);
      await js(`[...document.querySelectorAll('.mp-card')].find(c=>c.textContent.includes('HIL test pack'))?.querySelector('button.primary')?.click()`);
      await sleep(1500);
      await js(`[...document.querySelectorAll('.mp-card')].find(c=>c.textContent.includes('HIL test pack'))?.click()`);
      await sleep(600);
      await step("app-marketplace-browse");
      await click("Submit", ".page-header button");
      await sleep(500);
      await click("Choose folder");
      await sleep(800);
      await setVal(".submit-dialog input[placeholder='1.0.0']", "1.2.0");
      await setVal(".submit-dialog textarea", "Adds the /hil-report skill and the collect-logs.py helper; tested on HIL rack 01.");
      await click("Check", ".submit-dialog button");
      await sleep(800);
      await step("app-submit-dialog");
      await click("Cancel", ".submit-dialog button");
      await sleep(300);
      await click("My submissions", ".seg button");
      await sleep(1500);
      await step("app-submissions");
      // The reviewer asks for changes: the next refresh shows the feedback and a notice.
      stub.setStatus(14, { status: "changes_requested", reviewer: "mari", reviewedAt: new Date(Date.UTC(2026, 10, 18, 10, 5)).toISOString(),
        feedback: "Please make flash.ps1 stop after 3 retries and print the ECU's answer.\nAlso mention the required PowerShell version in the instructions." });
      await click("Refresh", ".page-header button");
      await sleep(2000);
      await step("app-submission-changes-requested");
      await js(`window.flash.api.updateCheck()`);
      await sleep(5500); // let the notice toast fade

      await click("Settings", ".sidebar button");
      await sleep(600);
      await click("About", ".tabs button");
      await sleep(800);
      await step("app-about-updates");
      stub.server.close();
      app.exit(0);
      return;
    }
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
      const send = async (text: string, sel = ".chat > .composer-wrap .composer2 textarea") => {
        await js(`(()=>{const t=document.querySelector(${JSON.stringify(sel)});const set=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;set.call(t,${JSON.stringify(text)});t.dispatchEvent(new Event('input',{bubbles:true}));t.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));})()`);
      };
      await send("Analyse the brake light feature: which SWCs and CAN signals are involved, and what should we test?");
      await sleep(900);
      await shot(join(demo, "1-streaming.png"));
      await js(`document.querySelector('.agents-float .spec-pill')?.click()`);
      await sleep(300);
      await shot(join(demo, "1b-agents-pill.png"));
      await js(`document.querySelector('.agents-float .spec-pill')?.click()`);
      // Each Specialists row shows its "open in a new window" button on hover.
      await js(`document.querySelector('.pill-stack > .spec-float:not(.agents-float) .spec-pill')?.click()`);
      await sleep(300);
      const row = await js<{ x: number; y: number } | null>(`(()=>{const r=document.querySelectorAll('.spec-row')[1]?.getBoundingClientRect();return r?{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}:null})()`);
      if (row) { win.webContents.sendInputEvent({ type: "mouseMove", x: row.x, y: row.y }); await sleep(300); }
      await shot(join(demo, "1c-specialists-popout.png"));
      await js(`document.querySelector('.pill-stack > .spec-float:not(.agents-float) .spec-pill')?.click()`);
      await sleep(4500);
      await js(`[...document.querySelectorAll('.msg-agent .msg-actions button')].find(b=>b.title==='Reply in thread')?.click()`);
      await sleep(500);
      await send("@reviewer double-check the signal scaling", ".inline-thread.open .composer2 textarea");
      await sleep(5500);
      await js(`(async()=>{const st=window.flash.api;const chats=await st.listChats((await st.listProjects())[0].id);const msgs=await st.listMessages(chats[0].id,null);const a=msgs.find(m=>m.author==='agent');if(a){await st.toggleReaction(a.id,'👍');await st.toggleReaction(a.id,'🚀');}})()`);
      await sleep(600);
      await shot(join(demo, "2-chat-thread-reactions.png"));
      // Threads open inline under their message: show the card from its header, then collapse it back to the pill
      await js(`document.querySelector('.inline-thread.open')?.closest('.msg')?.scrollIntoView({block:'start'})`);
      await sleep(300);
      await shot(join(demo, "2-thread-inline-open.png"));
      await js(`document.querySelector('.thread-pill.open')?.click()`);
      await sleep(600);
      await shot(join(demo, "2-thread-inline-collapsed.png"));
      // The classic side panel, then the same thread popped out into its own window
      await js(`document.querySelector('.thread-pill')?.click()`);
      await sleep(700);
      await js(`document.querySelector('.inline-thread.open button[title="Show in Threads panel"]')?.click()`);
      await sleep(900);
      await shot(join(demo, "2-threads-panel.png"));
      // Thread cleanup: the row menu (archive / delete), then the archived thread in its own section and as a chip in the chat
      await js(`document.querySelector('.threads-panel .tpl-item button[title="Thread actions"]')?.click()`);
      await sleep(300);
      await shot(join(demo, "2f-thread-menu.png"));
      await click("Archive thread", ".ctx-item");
      await sleep(500);
      await js(`document.querySelector('.tpl-archived-head')?.click()`);
      await js(`document.querySelector('.thread-pill.archived')?.closest('.msg')?.scrollIntoView({block:'center'})`);
      await sleep(500);
      await shot(join(demo, "2g-thread-archived.png"));
      await js(`document.querySelector('.threads-panel .tpl-item button[title="Thread actions"]')?.click()`);
      await sleep(200);
      await click("Restore thread", ".ctx-item");
      await sleep(500);
      await js(`document.querySelector('.threads-panel button[title="Collapse the Threads panel"]')?.click()`);
      await sleep(500);
      await shot(join(demo, "2-threads-panel-rail.png"));
      await js(`document.querySelector('.threads-panel .tpl-rail-btn')?.click()`);
      await sleep(300);
      await js(`document.querySelector('.thread-pill')?.click()`);
      await sleep(700);
      await js(`document.querySelector('.inline-thread.open button[title="Open in new window"]')?.click()`);
      await sleep(3500);
      const tw = BrowserWindow.getAllWindows().find((w) => w !== win && w.webContents.getURL().includes("#thread/"));
      if (tw) { writeFileSync(join(demo, "2-thread-window.png"), (await tw.webContents.capturePage()).toPNG()); tw.close(); }
      await click("Progress", ".chat-controls button");
      await sleep(900);
      await shot(join(demo, "2b-progress-flow.png"));
      await click("Progress", ".chat-controls button");
      await sleep(300);
      await send("@rca-analyst Analyse the brake light flicker with an Ishikawa root cause analysis");
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
      await js(`(async()=>{const a=window.flash.api;const p=(await a.listProjects())[0]?.id ?? null;
        await a.saveMemory({ content: "Mari prefers a minimal glass UI and Windows-style window controls", scope: "user", kind: "preference", importance: 4, pinned: true, tags: ["ui"] });
        await a.saveMemory({ content: "Merge PRs once CI is green on Windows, macOS and Linux", scope: "user", kind: "procedure", tags: ["ci"] });
        await a.saveMemory({ content: "Brake light debounce must stay at 20 ms (BCM requirement 1240)", scope: "project", projectId: p, kind: "decision", importance: 5, tags: ["brake", "timing"] });
        await a.saveMemory({ content: "HIL bench 3 cannot reach -20 °C; cold-start tests run in the climate chamber", scope: "project", projectId: p, tags: ["hil"] });})()`);
      // Project knowledge base: two entries as a teammate committed them, picked up by a sync (Memory page, project selected).
      const kbDir = join(proj, ".flashmaster", "knowledge");
      mkdirSync(kbDir, { recursive: true });
      writeFileSync(join(kbDir, "overview.md"), "---\ntags: brake, bcm\nimportance: 4\n---\n\n# Overview\n\nThe brake ECU reads the pedal switch over CAN (BrakeLightReq, 0x1A0) and drives the lamps through the BCM. SWCs: BrakePedal, LampCtrl, Diag.\n");
      writeFileSync(join(kbDir, "build-and-test.md"), "---\ntags: ci, hil\n---\n\n# Build and test\n\nDaVinci project in /config, CAPL tests in /tests/capl. HIL bench 3 runs the nightly suite; cold-start cases run in the climate chamber.\n");
      await js(`(async()=>{const p=(await window.flash.api.listProjects())[0]?.id; if (p) await window.flash.api.syncKnowledge(p);})()`);
      for (const [label, name] of [["Agents", "3-agents"], ["Dashboard", "4-dashboard"], ["Tasks", "5-tasks"], ["Memory", "5m-memory"], ["Settings", "6-settings"]] as const) {
        await click(label, ".sidebar button");
        await sleep(1200);
        await shot(join(demo, `${name}.png`));
        if (name === "5-tasks") {
          // Right-click menu on a task card (move, run, delete).
          await js(`(()=>{const c=document.querySelector('.task-card');const r=c.getBoundingClientRect();c.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:r.left+r.width/2,clientY:r.top+r.height/2}))})()`);
          await sleep(400);
          await shot(join(demo, "5b-tasks-menu.png"));
          await js(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))`);
          await sleep(200);
        }
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
      await click("Agents & when", ".docs-nav button");
      await sleep(500);
      await click("Code Reviewer", ".docs-nav button.sub");
      await sleep(700);
      await shot(join(demo, "18b-docs-agent-chat-button.png"));
      await click("Chat with", ".agent-hero-chat");
      await sleep(1200);
      await shot(join(demo, "18c-agent-chat-opened.png"));
      // Artifacts panel + diff viewer (mock harness produces a sample edit)
      if (!(await js<boolean>(`!!document.querySelector('.chat-link.active')`))) {
        if (!(await js<boolean>(`!!document.querySelector('.chat-link')`))) await click("brake-ecu", ".project-name");
        await js(`(()=>{const el=[...document.querySelectorAll('.chat-link')].find(e=>e.textContent.includes('General'));el?.click();})()`);
        await sleep(800);
      }
      await send("Implement the debounce for the brake pedal input (SRS 1102)");
      await sleep(5500);
      await js(`(()=>{const b=[...document.querySelectorAll('.chat .code-bar')].pop();b?.scrollIntoView({block:'center'});const btn=b?.querySelector('.code-copy');btn?.click();})()`);
      await sleep(300);
      await shot(join(demo, "23b-code-copy.png"));
      await click("Artifacts", ".chat-controls button");
      await sleep(800);
      await shot(join(demo, "24-artifacts-panel.png"));
      await js(`[...document.querySelectorAll('.art-item')].find(e=>e.querySelector('.art-name')?.textContent==='brake_light.c')?.click()`);
      await sleep(900);
      await shot(join(demo, "25-diff-split.png"));
      await js(`document.querySelector('.viewer-head .seg button[title="Unified"]')?.click()`);
      await sleep(400);
      await shot(join(demo, "26-diff-unified.png"));
      await js(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))`);
      await sleep(300);
      await click("Code", ".art-tabs button");
      await sleep(400);
      await shot(join(demo, "27-artifacts-code.png"));
      await click("Artifacts", ".chat-controls button");
      await sleep(200);
      // Steering delivery states
      await send("Review the CAN matrix for the BCM and list unused signals");
      await sleep(700);
      // Rename while the agent streams (the sidebar re-renders constantly)
      await js(`(()=>{const el=document.querySelector('.chat-link.active');el?.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));})()`);
      await sleep(150);
      await js(`(()=>{const i=document.querySelector('.chat-rename');const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;set.call(i,'CAN matrix review');i.dispatchEvent(new Event('input',{bubbles:true}));})()`);
      await sleep(1500);
      const typed = await js<string>(`document.querySelector('.chat-rename')?.value ?? "(gone)"`);
      await js(`document.querySelector('.chat-rename')?.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))`);
      await sleep(400);
      const saved = await js<string>(`document.querySelector('.chat-link.active .chat-title')?.textContent ?? ""`);
      log("info", `smoke-rename: typed-after-1.5s="${typed}" saved="${saved}"`);
      // Project rename (was window.prompt, unsupported in Electron)
      await js(`document.querySelector('.project-row.current .project-name')?.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`);
      await sleep(200);
      await js(`(()=>{const i=document.querySelector('.project-row .chat-rename');if(!i)return;const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;set.call(i,'BCM firmware');i.dispatchEvent(new Event('input',{bubbles:true}));i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));})()`);
      await sleep(600);
      const pname = await js<string>(`document.querySelector('.project-row.current .project-name')?.textContent ?? ""`);
      log("info", `smoke-rename-project: saved="${pname.trim()}"`);
      await send("focus on BCM_Status only");
      await sleep(250);
      await js(`(()=>{const l=document.querySelector('.chat .messages');l.scrollTop=l.scrollHeight})()`);
      await shot(join(demo, "28-steer-sent.png"));
      await sleep(6000);
      await js(`(()=>{const l=document.querySelector('.chat .messages');const b=[...document.querySelectorAll('.steer-badge')].pop();b?.scrollIntoView({block:'center'});})()`);
      await sleep(300);
      await shot(join(demo, "29-steer-seen.png"));
      // Chats open at the latest message (switch away and back)
      await click("Master chat", ".sidebar button");
      await sleep(600);
      await js(`(()=>{const el=[...document.querySelectorAll('.chat-link')].find(e=>e.textContent.includes('General'));el?.click();})()`);
      await sleep(900);
      const gap = await js<number>(`(()=>{const l=document.querySelector('.chat .messages');return Math.round(l.scrollHeight-l.scrollTop-l.clientHeight)})()`);
      const tall = await js<number>(`document.querySelector('.chat .messages').scrollHeight`);
      log("info", `smoke-scroll: distance-to-bottom=${gap} contentHeight=${tall}`);
      await shot(join(demo, "30-chat-opened-at-latest.png"));
      // Commands under a reply: click one open to see command + output
      await js(`document.querySelector('.chat-link')?.click()`);
      await sleep(900);
      await js(`(()=>{const h=[...document.querySelectorAll('.tool-run-head:not(:disabled)')].pop();h?.scrollIntoView({block:'center'});h?.click();})()`);
      await sleep(500);
      const toolOut = await js<string>(`document.querySelector('.tool-run.open .tool-run-pre')?.textContent ?? ""`);
      log("info", `smoke-tool-output: ${JSON.stringify(toolOut.slice(0, 60))}`);
      await shot(join(demo, "31-command-output.png"));
      // A hung tool call: ■ on its row stops that call only; the agent is told and carries on.
      await send("Flash the ECU and wait for the build server [hang]");
      await sleep(1500);
      const hung = await js<{ x: number; y: number } | null>(`(()=>{const r=[...document.querySelectorAll('.tool-run.stoppable')].pop();if(!r)return null;r.scrollIntoView({block:'center'});const b=r.getBoundingClientRect();return {x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2)}})()`);
      if (hung) { win.webContents.sendInputEvent({ type: "mouseMove", x: hung.x, y: hung.y }); await sleep(300); }
      await shot(join(demo, "31b-tool-call-stop.png"));
      await js(`[...document.querySelectorAll('.tool-run-stop')].pop()?.click()`);
      await sleep(3500);
      const stoppedRows = await js<number>(`document.querySelectorAll('.tool-run.stopped').length`);
      log("info", `smoke-tool-stop: stopped=${stoppedRows}`);
      await js(`(()=>{const r=[...document.querySelectorAll('.tool-run.stopped')].pop();r?.scrollIntoView({block:'center'});r?.querySelector('.tool-run-head')?.click();})()`);
      await sleep(400);
      await shot(join(demo, "31c-tool-call-stopped.png"));
      // Updates (FLASH_UPDATE_URL points at a local feed in the demo)
      if (process.env.FLASH_UPDATE_URL) {
        await js(`window.flash.api.updateCheck().then(()=>{})`);
        await sleep(1200);
        await click("Settings", ".sidebar button");
        await sleep(400);
        await click("About", ".tabs button");
        await sleep(700);
        await shot(join(demo, "31-updates.png"));
      }
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
    // The window/taskbar icon must load on this platform (Windows reads the .ico through its own icon loader).
    const iconOk = !!icon && !icon.isEmpty() && (process.platform !== "win32" || icon.file.endsWith(".ico"));
    log(iconOk ? "info" : "error", `smoke-icon: ok=${iconOk} file=${icon?.file ?? "-"} size=${icon?.getSize().width ?? 0}`);
    // Chat search must answer through IPC (the main log says whether FTS5 or the LIKE fallback is in use).
    const search = await js<string>("window.flash.api.searchMessages('brake').then((r) => Array.isArray(r) ? 'ok' : 'bad', (e) => String(e))");
    log(search === "ok" ? "info" : "error", `smoke-search: ${search}`);
    if (search !== "ok") { app.exit(1); return; }
    // Agent memory answers through IPC (the main log says whether FTS5 or the LIKE fallback is in use).
    const memory = await js<string>("window.flash.api.listMemories({ query: 'brake' }).then((r) => Array.isArray(r) ? 'ok' : 'bad', (e) => String(e))");
    log(memory === "ok" ? "info" : "error", `smoke-memory: ${memory}`);
    if (memory !== "ok") { app.exit(1); return; }
    // The integrated terminal: open it from the title bar, run a command in the real shell and see its output rendered.
    const term = ok && !demo ? await smokeTerminal(js) : "skipped";
    const termOk = term === "ok" || term === "skipped";
    log(termOk ? "info" : "error", `smoke: ui=${ok} terminal=${term}`);
    // An agent's chat popped out into its own window: it renders the chat, and opening it again focuses it instead of
    // duplicating it. Runs last: the new window takes focus, and macOS throttles the main window's timers behind it.
    const pop = ok ? await smokeChatWindow(win, js, demo) : "skipped";
    const popOk = pop === "ok" || pop === "skipped";
    log(popOk ? "info" : "error", `smoke-chat-window: ${pop}`);
    app.exit(ok && iconOk && termOk && popOk ? 0 : 1);
  } catch (e) {
    log("error", `smoke failed: ${String(e)}`);
    app.exit(2);
  }
}

/** Clicks the title bar's terminal button and runs a command whose output differs from what was typed. */
async function smokeTerminal(js: <T = unknown>(code: string) => Promise<T>): Promise<string> {
  const cmd = process.platform === "win32" ? "Write-Output ('flash'+'-smoke')" : "echo flash''-smoke";
  for (let i = 0; i < 2; i++) {
    const r = await js<string>(`(async () => {
      const wait = async (f, ms) => { const end = Date.now() + ms; while (Date.now() < end) { const v = f(); if (v) return v; await new Promise((r) => setTimeout(r, 200)); } return null; };
      if (!document.querySelector('.term-panel.open')) document.querySelector('.titlebar .term-toggle')?.click();
      const view = await wait(() => document.querySelector('.term-panel.open .term-view.visible'), 15000);
      if (!view) return 'no panel';
      const rows = () => view.querySelector('.xterm-rows')?.textContent ?? '';
      await wait(() => rows().trim().length > 0, 15000); // the prompt
      await window.flash.api.terminalWrite(view.dataset.term, ${JSON.stringify(cmd + "\r")});
      return (await wait(() => rows().split(${JSON.stringify(cmd)}).join('').includes('flash-smoke'), 20000)) ? 'ok' : 'no output: ' + rows().slice(-300);
    })()`).catch((e) => `error: ${String(e)}`);
    if (r === "ok" || i === 1) return r;
  }
  return "unreachable";
}

async function smokeChatWindow(win: BrowserWindow, js: <T = unknown>(code: string) => Promise<T>, demo: string | undefined): Promise<string> {
  const others = () => BrowserWindow.getAllWindows().filter((w) => w !== win && !w.isDestroyed());
  const before = new Set(others());
  const open = () => js<string>("window.flash.api.getMasterChat().then((c) => window.flash.api.openChatWindow(c.id)).then(() => 'ok', (e) => String(e?.message ?? e))");
  const first = await open();
  if (first !== "ok") return `open failed: ${first}`;
  let cw: BrowserWindow | undefined;
  for (let i = 0; i < 40 && !cw; i++) { cw = others().find((w) => !before.has(w)); if (!cw) await sleep(250); }
  if (!cw) return "no window";
  let rendered = false;
  for (let i = 0; i < 60 && !rendered; i++) { await sleep(250); rendered = await cw.webContents.executeJavaScript("!!document.querySelector('.chat-popout .chat-header')").catch(() => false); }
  if (!rendered) { const url = cw.webContents.getURL(); cw.close(); return `chat not rendered (${url.slice(url.indexOf("#")) || url || "no url"})`; }
  const second = await open();
  await sleep(400);
  const count = others().filter((w) => !before.has(w)).length;
  if (demo) writeFileSync(join(demo, "2-chat-window.png"), (await cw.webContents.capturePage()).toPNG());
  cw.close();
  win.focus();
  if (second !== "ok") return `reopen failed: ${second}`;
  return count === 1 ? "ok" : `duplicated (${count})`;
}
