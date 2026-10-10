// A workspace is one repository: its compile database and the folders the user
// chose to index. Configs live in the app's data directory, never in the repo.

import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { CdbEntry, entryArgs, headerEntries, INCLUDE_FLAGS } from "./headers";

export interface WorkspaceConfig {
  root: string;
  compileDb: string;
  // Folders to index, relative to root ("source", "extern/filament").
  roots: string[];
  // Include folders outside the repo to index too, by External.key.
  externals: string[];
}

/** An include folder outside the repo that compile db entries name (SDL3 from the Nix store). */
export interface External {
  // Survives a new store hash or version: "sdl3-dev/include".
  key: string;
  // As shown, and the prefix of its files' paths: "sdl3-3.4.0-dev/include".
  label: string;
  dir: string;
  headers: number;
  // Compile db entries that name it.
  users: number;
}

interface Store {
  last?: string;
  workspaces: Record<string, WorkspaceConfig>;
}

const SOURCE_EXTS = new Set([".c", ".h", ".cc", ".cpp", ".cxx", ".hh", ".hpp", ".hxx"]);
const HEADER_EXTS = new Set([".h", ".hh", ".hpp", ".hxx"]);
const SKIP_DIRS = new Set([".git", "node_modules", ".cache"]);

export function dataHome(): string {
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  return path.join(base, "codeviz");
}

/** Per-workspace directory: filtered compile db, clangd's index, symbol cache. */
export function workspaceDir(root: string): string {
  const id = crypto.createHash("sha1").update(root).digest("hex").slice(0, 12);
  return path.join(dataHome(), `${path.basename(root)}-${id}`);
}

function storePath(): string {
  return path.join(dataHome(), "workspaces.json");
}

export function loadStore(): Store {
  try {
    return JSON.parse(fs.readFileSync(storePath(), "utf8"));
  } catch {
    return { workspaces: {} };
  }
}

export function saveWorkspace(cfg: WorkspaceConfig): void {
  const store = loadStore();
  store.workspaces[cfg.root] = cfg;
  store.last = cfg.root;
  fs.mkdirSync(dataHome(), { recursive: true });
  fs.writeFileSync(storePath(), JSON.stringify(store, null, 2));
}

/**
 * compile_commands.json files at the root and up to three levels under build-like
 * folders. The best match comes first: the most entries under `roots`, or under
 * the whole repo when no folders are chosen yet.
 */
export function findCompileDbs(root: string, roots: string[] = []): string[] {
  const found: string[] = [];
  const top = path.join(root, "compile_commands.json");
  if (fs.existsSync(top)) found.push(top);
  const walk = (dir: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || SKIP_DIRS.has(e.name)) continue;
      const sub = path.join(dir, e.name);
      const cdb = path.join(sub, "compile_commands.json");
      if (fs.existsSync(cdb)) found.push(cdb);
      if (depth < 3) walk(sub, depth + 1);
    }
  };
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    if (e.isDirectory() && /^(build|out|cmake-build)/i.test(e.name)) {
      const sub = path.join(root, e.name);
      const cdb = path.join(sub, "compile_commands.json");
      if (fs.existsSync(cdb)) found.push(cdb);
      walk(sub, 1);
    }
  }
  const dirs = roots.length ? roots.map((r) => path.join(root, r)) : [root];
  const count = new Map<string, number>();
  for (const cdb of found) {
    let n = 0;
    try {
      for (const e of readCdb(cdb)) if (dirs.some((d) => isUnder(entryFile(e), d))) n++;
    } catch {
      // Unreadable or not JSON: it sorts last.
    }
    count.set(cdb, n);
  }
  return found.sort((a, b) => count.get(b)! - count.get(a)!);
}

function readCdb(cdbPath: string): CdbEntry[] {
  return JSON.parse(fs.readFileSync(cdbPath, "utf8"));
}

function entryFile(e: CdbEntry): string {
  return path.resolve(e.directory, e.file);
}

function isUnder(file: string, dir: string): boolean {
  const rel = path.relative(dir, file);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** Folders that hold compiled files, one and two levels deep, with file counts. */
export function folderCandidates(root: string, cdbPath: string): { path: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const e of readCdb(cdbPath)) {
    const file = entryFile(e);
    if (!isUnder(file, root)) continue;
    const parts = path.relative(root, file).split(path.sep).slice(0, -1);
    for (let depth = 1; depth <= Math.min(2, parts.length); depth++) {
      const key = parts.slice(0, depth).join("/");
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([p, count]) => ({ path: p, count }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Writes the compile db clangd sees: the entries under the chosen roots, and one
 * per header we read, made from the sources that include it (headers.ts).
 */
export function writeFilteredCdb(cfg: WorkspaceConfig, externals: External[], outDir: string): number {
  const roots = cfg.roots.map((r) => path.join(cfg.root, r));
  const all = readCdb(cfg.compileDb);
  const chosen = (e: CdbEntry) => roots.some((r) => isUnder(entryFile(e), r));
  const kept = all.filter(chosen);
  const headers = new Set(listSourceFiles(cfg, externals).filter((f) => HEADER_EXTS.has(path.extname(f).toLowerCase())));
  const extra = headerEntries([...kept, ...all.filter((e) => !chosen(e))], headers);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "compile_commands.json"), JSON.stringify([...kept, ...extra], null, 1));
  return kept.length;
}

/** C/C++ files under `dir`, or only headers. */
function walkSources(dir: string, exts: Set<string>, out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walkSources(p, exts, out);
    } else if ((e.isFile() || e.isSymbolicLink()) && exts.has(path.extname(e.name).toLowerCase())) {
      out.push(p);
    }
  }
}

/** Every C/C++ source and header under the chosen roots, and the headers of the chosen externals. */
export function listSourceFiles(cfg: WorkspaceConfig, externals: External[]): string[] {
  const files: string[] = [];
  for (const r of cfg.roots) walkSources(path.join(cfg.root, r), SOURCE_EXTS, files);
  for (const x of externals) walkSources(x.dir, HEADER_EXTS, files);
  return [...new Set(files)].sort();
}

/** The chosen root a file belongs to, the longest match first; for an external, its label. */
export function rootOf(cfg: WorkspaceConfig, externals: External[], file: string): string {
  let best = "";
  for (const r of cfg.roots) {
    if (isUnder(file, path.join(cfg.root, r)) && r.length > best.length) best = r;
  }
  if (best) return best;
  return externalOf(externals, file)?.label ?? "";
}

/** The deepest external that holds `file`. */
export function externalOf(externals: External[], file: string): External | undefined {
  let best: External | undefined;
  for (const x of externals) if (isUnder(file, x.dir) && (!best || x.dir.length > best.dir.length)) best = x;
  return best;
}

/**
 * A Nix store path's name without its hash and version, so a nixpkgs update
 * keeps the folder chosen: /nix/store/<hash>-sdl3-3.4.0-dev/include gives
 * "sdl3-dev/include" and the label "sdl3-3.4.0-dev/include". Other folders
 * are their absolute path.
 */
function externalName(dir: string): { key: string; label: string } {
  const m = /^\/nix\/store\/[a-z0-9]{32}-([^/]+)(.*)$/.exec(dir);
  if (!m) return { key: dir, label: dir };
  const parts = m[1].split("-");
  const v = parts.findIndex((p, i) => i > 0 && /^\d/.test(p));
  const pname = v < 0 ? parts : parts.slice(0, v);
  const output = v >= 0 && v < parts.length - 1 && !/^\d/.test(parts[parts.length - 1]) ? [parts[parts.length - 1]] : [];
  return { key: [...pname, ...output].join("-") + m[2], label: m[1] + m[2] };
}

/** Include folders outside the repo that the compile db names, the most used first. */
export function externalCandidates(root: string, cdbPath: string): External[] {
  const users = new Map<string, number>();
  for (const e of readCdb(cdbPath)) {
    const args = entryArgs(e);
    const dirs = new Set<string>();
    for (let i = 0; i < args.length; i++) {
      const flag = INCLUDE_FLAGS.find((f) => args[i].startsWith(f));
      if (!flag) continue;
      const value = args[i] === flag ? args[++i] : args[i].slice(flag.length);
      if (value) dirs.add(path.resolve(e.directory, value));
    }
    for (const d of dirs) if (d !== root && !isUnder(d, root)) users.set(d, (users.get(d) ?? 0) + 1);
  }
  const out: External[] = [];
  for (const [dir, n] of users) {
    if (!fs.existsSync(dir)) continue;
    const headers: string[] = [];
    walkSources(dir, HEADER_EXTS, headers);
    if (headers.length) out.push({ ...externalName(dir), dir, headers: headers.length, users: n });
  }
  return out.sort((a, b) => b.users - a.users || a.label.localeCompare(b.label));
}

/** The workspace's chosen externals, found in its compile db (at their current store paths). */
export function chosenExternals(cfg: WorkspaceConfig): External[] {
  if (!cfg.externals.length) return [];
  const keys = new Set(cfg.externals);
  return externalCandidates(cfg.root, cfg.compileDb).filter((x) => keys.has(x.key));
}
