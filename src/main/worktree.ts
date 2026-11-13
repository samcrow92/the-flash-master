/**
 * Git worktrees for agents that change code. Each such agent works on its own branch in its own folder, so agents
 * running in parallel on one project never overwrite each other. Nothing here deletes work that isn't merged:
 * removing a worktree with uncommitted changes or unmerged commits is refused unless the user forces it.
 */
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { runCapture } from "./harness/process";

export type Git = (cwd: string, args: string[]) => Promise<{ code: number | null; out: string }>;

export const defaultGit: Git = (cwd, args) => runCapture("git", ["-c", "core.quotepath=off", ...args], 60_000, cwd);

export interface WorktreeState {
  exists: boolean;
  /** Uncommitted changes in the worktree (they would be lost). */
  dirty: string[];
  /** Commits on the branch that the project's current branch doesn't have yet. */
  unmerged: number;
}

export interface WorkResult { ok: boolean; message: string }

/** A git repository with at least one commit (a worktree needs a commit to start from). */
export async function canIsolate(repo: string, git: Git = defaultGit): Promise<boolean> {
  if (!existsSync(repo)) return false;
  const inside = await git(repo, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.code !== 0 || inside.out.trim() !== "true") return false;
  return (await git(repo, ["rev-parse", "--verify", "--quiet", "HEAD"])).code === 0;
}

export async function createWorktree(repo: string, dir: string, branch: string, git: Git = defaultGit): Promise<WorkResult> {
  mkdirSync(dirname(dir), { recursive: true });
  const r = await git(repo, ["worktree", "add", "-b", branch, dir, "HEAD"]);
  return r.code === 0 ? { ok: true, message: `branch ${branch}` } : { ok: false, message: r.out.trim() || "git worktree add failed" };
}

export async function worktreeState(repo: string, dir: string, branch: string, git: Git = defaultGit): Promise<WorktreeState> {
  const exists = existsSync(dir);
  const dirty = exists ? (await git(dir, ["status", "--porcelain"])).out.split(/\r?\n/).filter((l) => l.trim()) : [];
  const count = await git(repo, ["rev-list", "--count", `HEAD..${branch}`]);
  return { exists, dirty, unmerged: count.code === 0 ? Number(count.out.trim()) || 0 : 0 };
}

/** Merge the agent's branch into the project's current branch. Refuses with uncommitted work on either side; aborts on conflict. */
export async function mergeWorktree(repo: string, dir: string, branch: string, git: Git = defaultGit): Promise<WorkResult> {
  const st = await worktreeState(repo, dir, branch, git);
  if (st.dirty.length) return { ok: false, message: `The agent's copy has ${st.dirty.length} uncommitted change(s). Ask it to commit them, or commit them yourself in ${dir}.` };
  if (!st.unmerged) return { ok: true, message: "Nothing to merge: the branch has no new commits." };
  const own = (await git(repo, ["status", "--porcelain", "--untracked-files=no"])).out.trim();
  if (own) return { ok: false, message: "Your project folder has uncommitted changes. Commit or stash them, then merge again." };
  const r = await git(repo, ["merge", "--no-ff", "--no-edit", branch]);
  if (r.code === 0) return { ok: true, message: `Merged ${st.unmerged} commit(s) from ${branch}.` };
  await git(repo, ["merge", "--abort"]);
  return { ok: false, message: `Merging ${branch} conflicts with your branch, so nothing was changed. Merge it by hand: git merge ${branch}` };
}

/** Remove the worktree and its branch. Unmerged or uncommitted work is kept unless `force` is set. */
export async function removeWorktree(repo: string, dir: string, branch: string, force: boolean, git: Git = defaultGit): Promise<WorkResult> {
  const st = await worktreeState(repo, dir, branch, git);
  if (!force && (st.dirty.length || st.unmerged)) {
    const what = [st.unmerged ? `${st.unmerged} unmerged commit(s)` : "", st.dirty.length ? `${st.dirty.length} uncommitted change(s)` : ""].filter(Boolean).join(" and ");
    return { ok: false, message: `Kept: the agent's copy has ${what}. Merge it first, or discard it explicitly.` };
  }
  if (st.exists) {
    const r = await git(repo, ["worktree", "remove", ...(force ? ["--force"] : []), dir]);
    if (r.code !== 0) return { ok: false, message: r.out.trim() || "git worktree remove failed" };
  } else await git(repo, ["worktree", "prune"]);
  await git(repo, ["branch", force ? "-D" : "-d", branch]);
  return { ok: true, message: `Removed the agent's copy and branch ${branch}.` };
}
