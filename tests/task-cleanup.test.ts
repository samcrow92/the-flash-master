import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Db } from "../src/main/db";
import { runTaskCleanup, tasksToClean } from "../src/main/task-cleanup";
import { DEFAULT_SETTINGS } from "../src/shared/settings";
import type { AgentRun, Task } from "../src/shared/types";

const MIN = 60_000, DAY = 86_400_000, NOW = 1_800_000_000_000;
const task = (id: string, p: Partial<Task> = {}): Task => ({ id, projectId: null, title: id, description: "", status: "todo", priority: 3,
  assigneeRole: null, agentId: null, parentId: null, jazzId: null, createdAt: NOW - 30 * DAY, updatedAt: NOW, ...p });
const agent = (id: string, status: AgentRun["status"], endedAt: number | null) => ({ id, status, endedAt }) as AgentRun;
const s = { deleteFinishedAfterMinutes: 60, deleteStaleAfterDays: 3 };

describe("task auto-cleanup", () => {
  it("defaults: finished tasks go after an hour, stale ones after 3 days", () => {
    expect(DEFAULT_SETTINGS.tasks).toEqual(s);
  });

  it("deletes done tasks and tasks whose agent stopped, failed or ended, once the delay has passed", () => {
    const agents = new Map([["stopped", agent("stopped", "stopped", NOW - 61 * MIN)], ["err", agent("err", "error", NOW - 61 * MIN)],
      ["fresh", agent("fresh", "stopped", NOW - 5 * MIN)], ["ended", agent("ended", "done", NOW - 2 * 60 * MIN)]]);
    const tasks = [
      task("done-old", { status: "done", updatedAt: NOW - 61 * MIN }),
      task("done-new", { status: "done", updatedAt: NOW - 59 * MIN }),
      task("stopped", { status: "in_progress", agentId: "stopped", updatedAt: NOW - 2 * 60 * MIN }),
      task("failed", { status: "blocked", agentId: "err", updatedAt: NOW - 61 * MIN }),
      task("stopped-recently", { status: "in_progress", agentId: "fresh", updatedAt: NOW - 2 * 60 * MIN }),
      task("ended-blocked", { status: "blocked", agentId: "ended", updatedAt: NOW - 2 * 60 * MIN }),
    ];
    expect(tasksToClean(tasks, agents, s, NOW)).toEqual(["done-old", "stopped", "failed", "ended-blocked"]);
  });

  it("deletes stale open tasks, but never Review tasks or tasks with a working agent", () => {
    const agents = new Map([["busy", agent("busy", "running", null)], ["waiting", agent("waiting", "idle", null)], ["gone", agent("gone", "done", NOW - 9 * DAY)]]);
    const old = NOW - 4 * DAY;
    const tasks = [
      task("stale-todo", { updatedAt: old }),
      task("stale-blocked", { status: "blocked", updatedAt: old }),
      task("recent-todo", { updatedAt: NOW - 2 * DAY }),
      task("review", { status: "review", updatedAt: NOW - 90 * DAY, agentId: "gone" }),
      task("running", { status: "in_progress", agentId: "busy", updatedAt: old }),
      task("idle-agent-done", { status: "done", agentId: "waiting", updatedAt: old }),
    ];
    expect(tasksToClean(tasks, agents, s, NOW)).toEqual(["stale-todo", "stale-blocked"]);
  });

  it("0 turns each rule off", () => {
    const tasks = [task("done", { status: "done", updatedAt: NOW - 400 * DAY }), task("todo", { updatedAt: NOW - 400 * DAY })];
    expect(tasksToClean(tasks, new Map(), { deleteFinishedAfterMinutes: 0, deleteStaleAfterDays: 3 }, NOW)).toEqual(["todo"]);
    expect(tasksToClean(tasks, new Map(), { deleteFinishedAfterMinutes: 60, deleteStaleAfterDays: 0 }, NOW)).toEqual(["done"]);
    expect(tasksToClean(tasks, new Map(), { deleteFinishedAfterMinutes: 0, deleteStaleAfterDays: 0 }, NOW)).toEqual([]);
  });

  it("removes the tasks from the database and tells the UI", () => {
    const db = new Db(":memory:");
    const a = db.createAgent({ projectId: null, chatId: null, role: "tester", harness: "mock", model: null, brief: "b" });
    db.updateAgent(a.id, { status: "stopped", ended: true });
    const done = db.createTask({ title: "done", status: "done" });
    const stopped = db.createTask({ title: "stopped", status: "in_progress", agentId: a.id });
    const review = db.createTask({ title: "review", status: "review", agentId: a.id });
    const open = db.createTask({ title: "open" });
    const deleted: string[] = [];
    const ids = runTaskCleanup(db, s, (id) => deleted.push(id), Date.now() + 61 * MIN);
    expect(new Set(ids)).toEqual(new Set([done.id, stopped.id]));
    expect(deleted).toEqual(ids);
    expect(db.listTasks().map((t) => t.id).sort()).toEqual([review.id, open.id].sort());
  });

  it("the task board has a right-click menu with delete, and the Delete key deletes the focused task", () => {
    const view = readFileSync(join(__dirname, "..", "src", "renderer", "views", "TasksView.tsx"), "utf8");
    expect(view).toMatch(/className="task-card"[\s\S]{0,200}onContextMenu=\{\(e\) => openMenu\(e, taskMenu\(t\)\)\}/);
    expect(view).toMatch(/label: "Delete"/);
    expect(view).toMatch(/e\.key === "Delete"/);
  });
});
