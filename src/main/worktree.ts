/**
 * Git worktrees for agents that change code. Each such agent works on its own branch in its own folder, so agents
 * running in parallel on one project never overwrite each other. Nothing here deletes work that isn't merged:
 * removing a worktree with uncommitted changes or unmerged commits is refused unless the user forces it.
 */
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
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

export type ChangeStatus = "added" | "modified" | "deleted";
export interface WorkFile { path: string; status: ChangeStatus; added: number; removed: number; binary: boolean; committed: boolean }

/** Where the agent's branch left the project's current branch: its changes are everything since this commit. */
async function reviewBase(repo: string, branch: string, git: Git): Promise<string> {
  const mb = await git(repo, ["merge-base", "HEAD", branch]);
  const sha = mb.code === 0 ? /^[0-9a-f]{7,64}$/m.exec(mb.out)?.[0] : undefined;
  return sha ?? "HEAD";
}

const MAX_REVIEW_FILES = 500;

/**
 * Every file the agent changed in its copy: committed on its branch, uncommitted, and new untracked files, compared with
 * where the branch started. This is what Merge brings in (once committed) and what Discard throws away.
 */
export async function worktreeChanges(repo: string, dir: string, branch: string, git: Git = defaultGit): Promise<{ base: string; files: WorkFile[] }> {
  const base = await reviewBase(repo, branch, git);
  if (!existsSync(dir)) return { base, files: [] };
  const [names, nums, untracked, committed] = await Promise.all([
    git(dir, ["diff", "--no-renames", "--name-status", base]),
    git(dir, ["diff", "--no-renames", "--numstat", base]),
    git(dir, ["ls-files", "--others", "--exclude-standard"]),
    git(dir, ["diff", "--no-renames", "--name-only", base, "HEAD"]),
  ]);
  // git's warnings share the output (e.g. "warning: in the working copy of 'a.c', LF will be replaced by CRLF" on Windows): skip them.
  const lines = (s: string) => s.split(/\r?\n/).filter((l) => l.trim() && !/^(warning|hint|error|fatal): /.test(l));
  const inCommits = new Set(committed.code === 0 ? lines(committed.out) : []);
  const stat = new Map<string, { added: number; removed: number; binary: boolean }>();
  for (const l of nums.code === 0 ? lines(nums.out) : []) {
    if (!/^(\d+|-)\t(\d+|-)\t./.test(l)) continue;
    const [a, r, ...p] = l.split("\t");
    stat.set(p.join("\t"), { added: Number(a) || 0, removed: Number(r) || 0, binary: a === "-" });
  }
  const files: WorkFile[] = [];
  for (const l of names.code === 0 ? lines(names.out) : []) {
    if (!/^[ACDMTUX]\d*\t./.test(l)) continue;
    const [code, ...p] = l.split("\t");
    const path = p.join("\t");
    const s = stat.get(path) ?? { added: 0, removed: 0, binary: false };
    files.push({ path, status: code?.startsWith("A") ? "added" : code?.startsWith("D") ? "deleted" : "modified", ...s, committed: inCommits.has(path) });
  }
  for (const path of untracked.code === 0 ? lines(untracked.out) : []) {
    const r = readText(dir, path);
    files.push({ path, status: "added", added: r.binary ? 0 : r.text ? r.text.split("\n").length - (r.text.endsWith("\n") ? 1 : 0) : 0, removed: 0, binary: r.binary, committed: false });
  }
  files.sort((x, y) => x.path.localeCompare(y.path));
  return { base, files: files.slice(0, MAX_REVIEW_FILES) };
}

const MAX_REVIEW_BYTES = 1_500_000;

/** Read a file inside `root`; refuses paths that leave it. Binary and very large files come back without text. */
function readText(root: string, path: string): { text: string; binary: boolean; tooLarge?: boolean } {
  const abs = resolve(root, path);
  const rel = relative(resolve(root), abs);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("path outside the agent's copy");
  if (!existsSync(abs)) return { text: "", binary: false };
  const st = statSync(abs);
  if (!st.isFile()) return { text: "", binary: false };
  if (st.size > MAX_REVIEW_BYTES) return { text: "", binary: false, tooLarge: true };
  const buf = readFileSync(abs);
  if (buf.subarray(0, 8000).includes(0)) return { text: "", binary: true };
  return { text: buf.toString("utf8"), binary: false };
}

/** One file of the agent's change: its text where the branch started, and its text in the agent's copy now. */
export async function worktreeFileDiff(repo: string, dir: string, branch: string, path: string, git: Git = defaultGit):
  Promise<{ oldText: string; newText: string; binary: boolean; tooLarge: boolean }> {
  const now = readText(dir, path);
  const base = await reviewBase(repo, branch, git);
  const old = await git(dir, ["show", `${base}:${path.replace(/\\/g, "/")}`]);
  const oldText = old.code === 0 ? old.out : "";
  const binary = now.binary || oldText.slice(0, 8000).includes("\0");
  const tooLarge = !!now.tooLarge || oldText.length > MAX_REVIEW_BYTES;
  return binary || tooLarge ? { oldText: "", newText: "", binary, tooLarge } : { oldText, newText: now.text, binary, tooLarge };
}
