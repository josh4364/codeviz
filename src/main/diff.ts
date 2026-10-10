// Symbol-level diffs of a commit, a range or the working tree, for the commit
// view. Each changed C/C++ file is parsed before and after (clangd, given the
// old text), symbols are matched by name, and every changed symbol becomes an
// entry with its two blocks aligned line by line. Changed lines outside every
// symbol, and changes to other files, become entries of their own. A submodule
// whose commit moved is diffed inside, between its two commits, and its files
// join the rest under its path.

import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { promisify } from "util";
import { blockRange, expandTabs } from "./blocks";
import { flatSymbols, identifiers, SymbolIndex, SymKind } from "./index";
import { settings } from "./settings";

const run = promisify(execFile);
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const CODE_EXTS = new Set([".c", ".h", ".cc", ".cpp", ".cxx", ".hh", ".hpp", ".hxx"]);
const MAX_FILE_LINES = 300;
const MAX_ALIGN_CELLS = 4_000_000;
const WORKERS = 8;
// More non-code files than this with one extension are listed in one box, not shown one by one.
const MAX_SAME_EXT = 6;

export interface Commit {
  sha: string;
  short: string;
  subject: string;
  author: string;
  date: string;
}

export type Change = "added" | "deleted" | "modified" | "moved";

export interface DiffEntry {
  id: string;
  // symbol: a function or type; outside: changed lines of a code file outside every symbol; file: a non-code file.
  type: "symbol" | "outside" | "file";
  change: Change;
  name: string;
  kind?: SymKind;
  file: string;
  oldFile?: string;
  // [line number, text]; rows index into them, -1 for nothing on that side, -2 for a gap.
  before: [number, string][];
  after: [number, string][];
  rows: [number, number][];
  added: number;
  removed: number;
}

export interface FileChange {
  path: string;
  oldPath?: string;
  status: "A" | "D" | "M" | "R";
  added: number;
  removed: number;
  binary: boolean;
  code: boolean;
  // Where to read it: the repo (the root, or a submodule) and its paths in there.
  git: GitSide;
}

interface GitSide {
  dir: string;
  base: string;
  head: string | null;
  path: string;
  oldPath?: string;
}

/** A submodule whose commit moved. `missing`: a commit is not in its checkout, so it is not diffed. */
export interface SubmoduleChange {
  path: string;
  base: string;
  head: string | null;
  commits: Commit[];
  missing: boolean;
}

export interface Diff {
  rev: string;
  label: string;
  base: string;
  head: string | null;
  commits: Commit[];
  body: string;
  files: FileChange[];
  submodules: SubmoduleChange[];
  deletedFiles: { path: string; lines: number; symbols: string[] }[];
  addedFiles: { path: string; lines: number; symbols: number }[];
  // Non-code files listed together by extension (see MAX_SAME_EXT).
  fileGroups: { ext: string; files: { path: string; added: number; removed: number }[] }[];
  entries: DiffEntry[];
  dropped: number;
  links: Record<string, { id: string; kind: SymKind }>;
}

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", args, { cwd: root, maxBuffer: 512 * 1024 * 1024 });
  return stdout;
}

const COMMIT_FORMAT = "--format=%H%x1f%h%x1f%s%x1f%an%x1f%aI%x1e";

function parseCommits(out: string): Commit[] {
  return out
    .split("\x1e")
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => {
      const [sha, short, subject, author, date] = r.split("\x1f");
      return { sha, short, subject, author, date };
    });
}

/**
 * A file's text at `rev`, or on disk when `rev` is "". `rel` must stay inside
 * the repo. A file in a submodule is read at the submodule's commit in `rev`.
 */
export async function fileAt(root: string, rev: string, rel: string): Promise<string> {
  const abs = path.resolve(root, rel);
  if (!abs.startsWith(path.resolve(root) + path.sep)) throw new Error(`outside the repo: ${rel}`);
  if (!rev) return fs.promises.readFile(abs, "utf8");
  const parts = path.relative(root, abs).split(path.sep);
  for (let i = 1; i < parts.length; i++) {
    const sub = parts.slice(0, i).join("/");
    if (!fs.existsSync(path.join(root, sub, ".git"))) continue;
    const sha = (await git(root, ["rev-parse", `${rev}:${sub}`])).trim();
    return fileAt(path.join(root, sub), sha, parts.slice(i).join("/"));
  }
  return git(root, ["show", `${rev}:${parts.join("/")}`]);
}

/** Recent commits on HEAD and how many files the working tree changes. */

export async function recentCommits(root: string, limit: number): Promise<{ worktree: number; commits: Commit[] }> {
  const [log, status] = await Promise.all([
    git(root, ["log", `-n${limit}`, COMMIT_FORMAT]),
    git(root, ["status", "--porcelain", "-z"]),
  ]);
  const worktree = status.split("\0").filter((e) => e.length > 3 && !e.startsWith("?? .")).length;
  return { worktree, commits: parseCommits(log) };
}

/**
 * What to compare. "" or "worktree": HEAD against the files on disk. "A..B":
 * A against B. "A...B": B against its merge base with A (a PR). Anything else
 * is one commit against its parent.
 */
async function resolve(root: string, rev: string): Promise<{ base: string; head: string | null; label: string }> {
  const r = rev.trim();
  if (!r || r.toLowerCase() === "worktree") return { base: "HEAD", head: null, label: "working tree" };
  if (r.includes("...")) {
    const [a, b] = r.split("...");
    const base = (await git(root, ["merge-base", a || "HEAD", b || "HEAD"])).trim();
    return { base, head: b || "HEAD", label: r };
  }
  if (r.includes("..")) {
    const [a, b] = r.split("..");
    return { base: a || "HEAD", head: b || "HEAD", label: r };
  }
  const parent = await git(root, ["rev-parse", "--verify", "--quiet", `${r}^`]).catch(() => "");
  return { base: parent.trim() || EMPTY_TREE, head: r, label: r };
}

const GITLINK = "160000";

/**
 * The files that changed in the repo at `dir` (`prefix`: its path in the root
 * repo), with each moved submodule's files in its place.
 */
async function changedFiles(dir: string, prefix: string, base: string, head: string | null, subs: SubmoduleChange[]): Promise<FileChange[]> {
  const args = ["diff", "--raw", "-z", "-M", "--abbrev=40", base];
  if (head) args.push(head);
  const parts = (await git(dir, args)).split("\0");
  const out: FileChange[] = [];
  const add = (status: FileChange["status"], p: string, oldPath?: string) => {
    out.push({
      path: prefix + p,
      oldPath: oldPath === undefined ? undefined : prefix + oldPath,
      status,
      added: 0,
      removed: 0,
      binary: false,
      code: CODE_EXTS.has(path.extname(p).toLowerCase()),
      git: { dir, base, head, path: p, oldPath },
    });
  };
  for (let i = 0; i < parts.length - 1; ) {
    const meta = parts[i++];
    if (!meta.startsWith(":")) continue;
    const [oldMode, newMode, oldSha, newSha, st] = meta.slice(1).split(" ");
    const code = st[0];
    if (code === "R" || code === "C") {
      const oldPath = parts[i++];
      const p = parts[i++];
      add(code === "R" ? "R" : "A", p, code === "R" ? oldPath : undefined);
      continue;
    }
    const p = parts[i++];
    if (code === "M" && oldMode === GITLINK && newMode === GITLINK) {
      // In the working tree the submodule's own working tree is the new side.
      const files = await submodule(prefix + p, path.join(dir, p), oldSha, head === null ? null : newSha, subs);
      if (files) {
        out.push(...files);
        continue;
      }
    }
    add(code === "A" ? "A" : code === "D" ? "D" : "M", p);
  }
  if (!head) {
    const untracked = (await git(dir, ["ls-files", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean);
    for (const p of untracked) add("A", p);
  }
  return out;
}

/**
 * A submodule's changed files between its two commits (`head` null: its
 * working tree), or null when its checkout lacks one of them; the pointer
 * change then shows as a file.
 */
async function submodule(rel: string, dir: string, base: string, head: string | null, subs: SubmoduleChange[]): Promise<FileChange[] | null> {
  const has = (sha: string) => git(dir, ["cat-file", "-e", `${sha}^{commit}`]).then(() => true, () => false);
  const ok = fs.existsSync(path.join(dir, ".git")) && (await has(base)) && (head === null || (await has(head)));
  const commits = ok ? parseCommits(await git(dir, ["log", "-n50", COMMIT_FORMAT, `${base}..${head ?? "HEAD"}`]).catch(() => "")) : [];
  subs.push({ path: rel, base, head, commits, missing: !ok });
  return ok ? changedFiles(dir, rel + "/", base, head, subs) : null;
}

async function content(g: GitSide, rev: string | null, p: string): Promise<string | null> {
  try {
    if (rev === null) return fs.readFileSync(path.join(g.dir, p), "utf8");
    return await git(g.dir, ["show", `${rev}:${p}`]);
  } catch {
    return null;
  }
}

interface Hunk {
  // First changed line on each side (1-based); with no lines, where the change sits.
  o0: number;
  n0: number;
  old: string[];
  new: string[];
}

async function hunks(g: GitSide): Promise<Hunk[]> {
  const args = ["diff", "-U0", "--no-color", "-M", g.base];
  if (g.head) args.push(g.head);
  args.push("--", ...(g.oldPath ? [g.oldPath, g.path] : [g.path]));
  const out: Hunk[] = [];
  let h: Hunk | null = null;
  for (const line of (await git(g.dir, args)).split("\n")) {
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (m) {
      const oc = m[2] === undefined ? 1 : Number(m[2]);
      const nc = m[4] === undefined ? 1 : Number(m[4]);
      h = { o0: Number(m[1]) + (oc === 0 ? 1 : 0), n0: Number(m[3]) + (nc === 0 ? 1 : 0), old: [], new: [] };
      out.push(h);
    } else if (h && line.startsWith("-")) h.old.push(line.slice(1));
    else if (h && line.startsWith("+")) h.new.push(line.slice(1));
  }
  return out;
}

// ---- symbols on one side ----------------------------------------------------

interface SideSym {
  key: string;
  name: string;
  kind: SymKind;
  file: string;
  start: number;
  end: number;
  lines: string[];
}

async function sideSymbols(index: SymbolIndex, root: string, p: string, text: string): Promise<SideSym[]> {
  const tree = await index.documentSymbols(path.join(root, p), text);
  const lines = text.split("\n");
  const byKey = new Map<string, SideSym>();
  for (const { s, container, kind } of flatSymbols(tree)) {
    if (s.name.startsWith("(")) continue;
    const group = kind === "function" || kind === "method" ? "fn" : "type";
    const key = `${group}|${container}|${s.name}`;
    const { start, end } = blockRange(lines, s.range.start.line + 1, s.range.end.line + 1);
    const prev = byKey.get(key);
    // A typedef and its struct come as two symbols; keep the wider one, the record first.
    if (prev && prev.end - prev.start >= end - start) continue;
    byKey.set(key, { key, name: s.name, kind, file: p, start, end, lines: lines.slice(start - 1, end).map(expandTabs) });
  }
  return [...byKey.values()];
}

// ---- alignment --------------------------------------------------------------

/** Line pairs of a and b by longest common subsequence; -1 where a side has nothing. */
function align(a: string[], b: string[]): [number, number][] {
  const n = a.length;
  const m = b.length;
  const ops: [number, number][] = [];
  if ((n + 1) * (m + 1) > MAX_ALIGN_CELLS) {
    for (let i = 0; i < n; i++) ops.push([i, -1]);
    for (let j = 0; j < m; j++) ops.push([-1, j]);
    return pairRuns(ops);
  }
  const ta = a.map((l) => l.trimEnd());
  const tb = b.map((l) => l.trimEnd());
  const w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = ta[i] === tb[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && ta[i] === tb[j]) ops.push([i++, j++]);
    else if (j < m && (i === n || dp[i * w + j + 1] >= dp[(i + 1) * w + j])) ops.push([-1, j++]);
    else ops.push([i++, -1]);
  }
  return pairRuns(ops);
}

/** Puts each run of removed lines next to the run of added lines beside it, so they read as changed lines. */
function pairRuns(ops: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  for (let k = 0; k < ops.length; ) {
    if (ops[k][0] >= 0 && ops[k][1] >= 0) {
      out.push(ops[k++]);
      continue;
    }
    const dels: number[] = [];
    const adds: number[] = [];
    while (k < ops.length && !(ops[k][0] >= 0 && ops[k][1] >= 0)) {
      if (ops[k][0] >= 0) dels.push(ops[k][0]);
      else adds.push(ops[k][1]);
      k++;
    }
    for (let r = 0; r < Math.max(dels.length, adds.length); r++) out.push([dels[r] ?? -1, adds[r] ?? -1]);
  }
  return out;
}

function stats(e: Pick<DiffEntry, "before" | "after" | "rows">): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const [b, a] of e.rows) {
    if (b === -2) continue;
    if (b >= 0 && a >= 0) {
      if (e.before[b][1].trimEnd() !== e.after[a][1].trimEnd()) {
        added++;
        removed++;
      }
    } else if (b >= 0) removed++;
    else if (a >= 0) added++;
  }
  return { added, removed };
}

function symbolEntry(change: Change, b: SideSym | null, a: SideSym | null): DiffEntry {
  const s = (a ?? b)!;
  const before: [number, string][] = b ? b.lines.map((t, i) => [b.start + i, t]) : [];
  const after: [number, string][] = a ? a.lines.map((t, i) => [a.start + i, t]) : [];
  const rows = align(b?.lines ?? [], a?.lines ?? []);
  const e: DiffEntry = {
    id: `${change}:${s.file}:${s.key}`,
    type: "symbol",
    change,
    name: s.name,
    kind: s.kind,
    file: s.file,
    oldFile: b && a && b.file !== a.file ? b.file : undefined,
    before,
    after,
    rows,
    added: 0,
    removed: 0,
  };
  return { ...e, ...stats(e) };
}

/** An entry from hunks: each hunk's old and new lines side by side, hunks apart by gaps. */
function hunkEntry(type: "outside" | "file", change: Change, f: FileChange, hs: Hunk[], name: string): DiffEntry | null {
  const before: [number, string][] = [];
  const after: [number, string][] = [];
  const rows: [number, number][] = [];
  for (const h of hs) {
    if (!h.old.length && !h.new.length) continue;
    if (rows.length) rows.push([-2, -2]);
    const bi = before.length;
    const ai = after.length;
    h.old.forEach((t, i) => before.push([h.o0 + i, expandTabs(t)]));
    h.new.forEach((t, i) => after.push([h.n0 + i, expandTabs(t)]));
    for (const [b, a] of align(h.old, h.new)) rows.push([b < 0 ? -1 : bi + b, a < 0 ? -1 : ai + a]);
  }
  if (!rows.length) return null;
  const e: DiffEntry = { id: `${type}:${f.path}`, type, change, name, file: f.path, oldFile: f.oldPath, before, after, rows, added: 0, removed: 0 };
  return { ...e, ...stats(e) };
}

/** The lines of each hunk that no symbol block covers, and are not blank. */
function outside(hs: Hunk[], oldBlocks: SideSym[], newBlocks: SideSym[]): Hunk[] {
  const covered = (blocks: SideSym[], line: number) => blocks.some((s) => line >= s.start && line <= s.end);
  const out: Hunk[] = [];
  for (const h of hs) {
    const old: string[] = [];
    const neu: string[] = [];
    let o0 = -1;
    let n0 = -1;
    h.old.forEach((t, i) => {
      if (!t.trim() || covered(oldBlocks, h.o0 + i)) return;
      if (o0 < 0) o0 = h.o0 + i;
      old.push(t);
    });
    h.new.forEach((t, i) => {
      if (!t.trim() || covered(newBlocks, h.n0 + i)) return;
      if (n0 < 0) n0 = h.n0 + i;
      neu.push(t);
    });
    if (old.length || neu.length) out.push({ o0: o0 < 0 ? h.o0 : o0, n0: n0 < 0 ? h.n0 : n0, old, new: neu });
  }
  return out;
}

// ---- the diff -----------------------------------------------------------------

async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  }));
}

export async function buildDiff(index: SymbolIndex, rev: string): Promise<Diff> {
  const root = index.cfg.root;
  const { base, head, label } = await resolve(root, rev);
  const commits = head ? parseCommits(await git(root, ["log", "-n50", COMMIT_FORMAT, `${base}..${head}`]).catch(() => "")) : [];
  const body = head && commits.length === 1 ? (await git(root, ["log", "-1", "--format=%B", commits[0].sha])).trim() : "";
  const submodules: SubmoduleChange[] = [];
  const files = (await changedFiles(root, "", base, head, submodules)).slice(0, settings().diffMaxFiles);

  const entries: DiffEntry[] = [];
  const deletedSyms: SideSym[] = [];
  const addedSyms: SideSym[] = [];
  const deletedFiles: Diff["deletedFiles"] = [];
  const addedFiles: Diff["addedFiles"] = [];

  await pool(files, WORKERS, async (f) => {
    const g = f.git;
    const oldText = f.status === "A" ? null : await content(g, g.base, g.oldPath ?? g.path);
    const newText = f.status === "D" ? null : await content(g, g.head, g.path);
    f.binary = [oldText, newText].some((t) => t !== null && t.slice(0, 8000).includes("\0"));
    const oldLines = oldText === null ? 0 : oldText.split("\n").length;
    const newLines = newText === null ? 0 : newText.split("\n").length;
    if (f.binary) return;
    if (f.status === "A") f.added = newLines;
    if (f.status === "D") f.removed = oldLines;
    const hs = f.status === "M" || f.status === "R" ? await hunks(g) : [];
    for (const h of hs) {
      f.added += h.new.length;
      f.removed += h.old.length;
    }

    if (!f.code) {
      if (f.status === "D") deletedFiles.push({ path: f.path, lines: oldLines, symbols: [] });
      else if (f.status === "A") {
        const lines = newText!.split("\n").slice(0, MAX_FILE_LINES);
        addedFiles.push({ path: f.path, lines: newLines, symbols: 0 });
        const e = hunkEntry("file", "added", f, [{ o0: 1, n0: 1, old: [], new: lines }], path.basename(f.path));
        if (e) entries.push(e);
      } else {
        const e = hunkEntry("file", "modified", f, hs, path.basename(f.path));
        if (e) entries.push(e);
      }
      return;
    }

    const before = oldText === null ? [] : await sideSymbols(index, root, f.oldPath ?? f.path, oldText);
    const after = newText === null ? [] : await sideSymbols(index, root, f.path, newText);
    if (f.status === "D") deletedFiles.push({ path: f.path, lines: oldLines, symbols: before.map((s) => s.name) });
    if (f.status === "A") addedFiles.push({ path: f.path, lines: newLines, symbols: after.length });
    const afterByKey = new Map(after.map((s) => [s.key, s]));
    const beforeKeys = new Set(before.map((s) => s.key));
    for (const b of before) {
      const a = afterByKey.get(b.key);
      if (!a) deletedSyms.push(b);
      else if (b.lines.join("\n") !== a.lines.join("\n")) entries.push(symbolEntry("modified", b, a));
    }
    for (const a of after) if (!beforeKeys.has(a.key)) addedSyms.push(a);
    const out = hunkEntry("outside", "modified", f, outside(hs, before, after), `${path.basename(f.path)} (outside symbols)`);
    if (out) entries.push(out);
  });

  // A symbol gone from one file and new in another moved.
  const addedByKey = new Map<string, SideSym[]>();
  for (const a of addedSyms) addedByKey.set(a.key, [...(addedByKey.get(a.key) ?? []), a]);
  const moved = new Set<SideSym>();
  for (const b of deletedSyms) {
    const cands = addedByKey.get(b.key);
    if (cands?.length !== 1 || moved.has(cands[0])) continue;
    moved.add(cands[0]);
    moved.add(b);
    entries.push(symbolEntry("moved", b, cands[0]));
  }
  const goneFiles = new Set(deletedFiles.map((d) => d.path));
  for (const b of deletedSyms) if (!moved.has(b) && !goneFiles.has(b.file)) entries.push(symbolEntry("deleted", b, null));
  for (const a of addedSyms) if (!moved.has(a)) entries.push(symbolEntry("added", null, a));

  const byExt = new Map<string, DiffEntry[]>();
  for (const e of entries) {
    if (e.type !== "file") continue;
    const ext = path.extname(e.file).toLowerCase() || path.basename(e.file);
    byExt.set(ext, [...(byExt.get(ext) ?? []), e]);
  }
  const fileGroups: Diff["fileGroups"] = [];
  const grouped = new Set<DiffEntry>();
  for (const [ext, list] of byExt) {
    if (list.length <= MAX_SAME_EXT) continue;
    list.sort((a, b) => b.added + b.removed - (a.added + a.removed));
    fileGroups.push({ ext, files: list.map((e) => ({ path: e.file, added: e.added, removed: e.removed })) });
    for (const e of list) grouped.add(e);
  }
  const rest = entries.filter((e) => !grouped.has(e));
  // Code first, biggest change first.
  rest.sort((x, y) => Number(x.type === "file") - Number(y.type === "file") || y.added + y.removed - (x.added + x.removed) || x.file.localeCompare(y.file));
  const kept = rest.slice(0, settings().diffMaxEntries);
  const links: Diff["links"] = {};
  for (const e of kept) {
    for (const [, t] of [...e.before, ...e.after]) {
      for (const n of identifiers(t)) {
        if (n in links) continue;
        const s = index.named(n)[0];
        if (s) links[n] = { id: s.id, kind: s.kind };
      }
    }
  }
  files.sort((a, b) => b.added + b.removed - (a.added + a.removed));
  return { rev, label, base, head, commits, body, files, submodules, deletedFiles, addedFiles, fileGroups, entries: kept, dropped: rest.length - kept.length, links };
}
