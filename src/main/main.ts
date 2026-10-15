// Electron main process. It owns the HTTP server and clangd; closing the app stops both.
//
// Flags:
//   --workspace <repo>   open this repo (its saved folders, or the workspace form)
//   --roots <a,b>        index these folders of --workspace (saved as its config)
//   --compile-db <path>  with --roots: the compile db (default: the first one found)
//   --port <n>           serve on this port instead of a random one
//   --shot <png>         render hidden, wait for the index, save a screenshot, quit
//   --query <text>       type this into the search box first (with --shot)
//   --cluster <name>     open this symbol's cluster first (with --shot)
//   --layout <name>      with --cluster: file, folder, kind, relation or affinity
//   --diff <rev>         open a commit tab: a sha, A..B, main...branch, or "worktree".
//                        With an app already running, it opens there instead.
//   --eval <js>          run this in the page last, awaited (with --shot), to drive the UI
//   --help, -h           print these flags and exit
// An unknown flag prints an error and exits with 1.
//
// One app runs at a time (except --shot); a second launch forwards --diff to
// it and focuses its window.
//
// The projector: an agent drives the running app with POST /api/view (see
// view() below; src/main/mcp.ts wraps it as MCP tools). On listen the app
// writes { port, pid } to $XDG_STATE_HOME/codeviz/server.json (default
// ~/.local/state/codeviz/server.json) so clients find it, and removes it on quit.

import { app, BrowserWindow, dialog } from "electron";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Server } from "./http";
import { settings } from "./settings";
import { findCompileDbs, loadStore, WorkspaceConfig } from "./workspace";

interface Args {
  workspace?: string;
  roots?: string[];
  compileDb?: string;
  port: number;
  shot?: string;
  query?: string;
  cluster?: string;
  layout?: string;
  diff?: string;
  eval?: string;
}

const HELP = `codeviz: C/C++ code search, clusters and commit views over clangd

  --workspace <repo>   open this repo (its saved folders, or the workspace form)
  --roots <a,b>        index these folders of --workspace (saved as its config)
  --compile-db <path>  with --roots: the compile db (default: the first one found)
  --port <n>           serve on this port instead of a random one
  --diff <rev>         open a commit tab: a sha, A..B, main...branch, or "worktree"
  --shot <png>         render hidden, wait for the index, save a screenshot, quit
  --query <text>       with --shot: type this into Symbol search
  --cluster <name>     with --shot: open this symbol's cluster
  --layout <name>      with --cluster or --diff: the layout
  --eval <js>          with --shot: run this in the page last, awaited
  --help, -h           print this and exit

A running app takes projector commands on POST /api/view; its port is in
$XDG_STATE_HOME/codeviz/server.json. codeviz-mcp exposes them to Claude Code.`;

/** The flags. `strict` (this process's own argv) exits on --help or an unknown flag. */
function parseArgs(argv: string[], strict = false): Args {
  const args: Args = { port: 0 };
  for (let i = 0; i < argv.length; i++) {
    const next = () => argv[++i];
    switch (argv[i]) {
      case "--help":
      case "-h":
        if (strict) {
          console.log(HELP);
          process.exit(0);
        }
        break;
      case "--workspace":
        args.workspace = path.resolve(next());
        break;
      case "--roots":
        args.roots = next().split(",").filter(Boolean);
        break;
      case "--compile-db":
        args.compileDb = path.resolve(next());
        break;
      case "--port":
        args.port = Number(next());
        break;
      case "--shot":
        args.shot = path.resolve(next());
        break;
      case "--query":
        args.query = next();
        break;
      case "--cluster":
        args.cluster = next();
        break;
      case "--layout":
        args.layout = next();
        break;
      case "--diff":
        args.diff = next();
        break;
      case "--eval":
        args.eval = next();
        break;
      default:
        // Electron and Chromium put their own switches in argv; only unknown "--" words of ours fail.
        if (strict && argv[i].startsWith("-") && !CHROMIUM_FLAG.test(argv[i])) {
          console.error(`codeviz: unknown flag ${argv[i]} (see --help)`);
          process.exit(1);
        }
    }
  }
  return args;
}

// The window class and name the desktop entry's StartupWMClass matches.
app.commandLine.appendSwitch("class", "codeviz");
app.setName("codeviz");

// Switches Electron or Chromium may add to argv (a packaged launch, --no-sandbox, ...): name=value or known ones.
const CHROMIUM_FLAG = /^--(no-sandbox|inspect|remote-debugging|enable-|disable-|ozone|class|allow-|js-flags|user-data-dir|[a-z-]+=)/;

// argv[1] is the app folder ("." or lib/codeviz); it is not a flag.
const own = process.argv.slice(1);
const args = parseArgs(own, true);
let server: Server;
let win: BrowserWindow | null = null;

async function start(): Promise<void> {
  const uiDir = path.resolve(__dirname, "..", "..", "src", "ui");
  server = new Server(uiDir, {
    pickFolder: async () => {
      if (!win) return null;
      const r = await dialog.showOpenDialog(win, { properties: ["openDirectory"] });
      return r.canceled ? null : r.filePaths[0];
    },
    // A window's transparency is fixed when it is made, so a change makes a new one in its place.
    settingsChanged: (now, before) => {
      if (now.transparent !== before.transparent && win && !args.shot) replaceWindow();
    },
    view: (body) => view(body).catch((e) => ({ code: 500, body: { error: String(e?.message ?? e) } })),
  });
  const port = await server.listen(args.port);
  const url = `http://127.0.0.1:${port}/`;
  console.log(`codeviz: serving ${url}`);
  if (!args.shot) writeServerFile(port);

  const store = loadStore();
  const root = args.workspace ?? store.last;
  let saved: WorkspaceConfig | undefined = root ? store.workspaces[root] : undefined;
  if (root && args.roots) {
    const compileDb = args.compileDb ?? saved?.compileDb ?? findCompileDbs(root, args.roots)[0];
    if (compileDb) saved = { root, compileDb, roots: args.roots, externals: saved?.externals ?? [] };
  }
  if (saved) await server.openWorkspace(saved);

  const query = new URLSearchParams();
  if (root && !saved) query.set("root", root);
  pageUrl = url + (query.size ? `?${query}` : "");
  win = makeWindow({ width: 1200, height: 820 });
  await win.loadURL(pageUrl);
  if (args.shot) await shot(win, args.shot);
  else if (args.diff !== undefined) await openDiff(win, args.diff);
}

let pageUrl = "";

/** The app window; transparent (the desktop shows through) when the settings say so. */
function makeWindow(bounds: Electron.Rectangle | { width: number; height: number }): BrowserWindow {
  const transparent = settings().transparent;
  const w = new BrowserWindow({
    ...bounds,
    show: !args.shot,
    transparent,
    backgroundColor: transparent ? "#00000000" : "#0c0d10",
    title: "codeviz",
    webPreferences: { contextIsolation: true },
  });
  w.setMenuBarVisibility(false);
  return w;
}

/** Makes a new window over the old one, then closes the old one (the app quits when none is left). */
async function replaceWindow(): Promise<void> {
  const old = win!;
  win = makeWindow(old.getBounds());
  await win.loadURL(pageUrl);
  old.destroy();
}

// ---- the projector ----------------------------------------------------------

/** Where a running app says its port: $XDG_STATE_HOME/codeviz/server.json. */
export function serverFile(): string {
  const state = process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
  return path.join(state, "codeviz", "server.json");
}

function writeServerFile(port: number): void {
  const f = serverFile();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ port, pid: process.pid }) + "\n");
}

/** Removes server.json when it is still ours (a newer app may have written it). */
function removeServerFile(): void {
  try {
    const f = serverFile();
    if (JSON.parse(fs.readFileSync(f, "utf8")).pid === process.pid) fs.unlinkSync(f);
  } catch {
    // Gone already.
  }
}

const ok = (body: object) => ({ code: 200, body: { ok: true, ...body } });
const fail = (code: number, error: string) => ({ code, body: { error } });

/**
 * One projector command, POST /api/view { cmd, repo?, newTab?, focus?, ... }:
 *   diff {rev, layout?}           a commit tab: a sha, A..B, main...branch or "worktree"
 *   file {path, line?, endLine?}  a source file as a box, the range tinted and framed (a .md opens as a doc)
 *   symbol {name, layout?}        that symbol's cluster
 *   search {query}                Symbol search
 *   shot {path?}                  the window as a PNG; returns its path
 *   state                         workspace, index phase, view and tab
 * `repo` (absolute) switches to that repo's saved workspace first. Display
 * commands reuse the ▶ projector tab unless `newTab`. The window is shown
 * without focus (showInactive) unless `focus`.
 */
async function view(b: any): Promise<{ code: number; body: unknown }> {
  if (!win) return fail(503, "the window is not open");
  const cmd = String(b?.cmd ?? "");
  const w = win;
  const js = (s: string) => w.webContents.executeJavaScript(s);

  if (b.repo) {
    const repo = path.resolve(String(b.repo));
    if (server.workspace?.root !== repo) {
      const saved = loadStore().workspaces[repo];
      if (!saved) return fail(404, `no saved workspace for ${repo}; set it up on codeviz's Workspace page first`);
      await server.openWorkspace(saved);
      await js("window.codeviz.refresh()");
    }
  }
  const ws = server.workspace;

  if (cmd === "state") {
    const where = await js("window.codeviz.where()");
    return ok({ workspace: ws?.root ?? null, phase: server.phase, ...where, window: { visible: w.isVisible(), focused: w.isFocused(), minimized: w.isMinimized() } });
  }
  if (cmd === "shot") {
    const out = path.resolve(b.path ? String(b.path) : path.join(os.homedir(), ".cache", "codeviz", "shots", `shot-${Date.now()}.png`));
    // A hidden or minimized window captures nothing; show it without taking focus.
    if (!w.isVisible() || w.isMinimized()) {
      w.showInactive();
      await new Promise((r) => setTimeout(r, 300));
    }
    await js("window.codeviz.ready()");
    const img = await w.webContents.capturePage();
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, img.toPNG());
    const size = img.getSize();
    return ok({ path: out, width: size.width, height: size.height });
  }

  const ARGS: Record<string, (b: any) => string | object> = {
    diff: (b) => (b.rev ? { rev: String(b.rev), layout: b.layout ?? null } : "diff needs rev"),
    file: (b) => {
      if (!b.path) return "file needs path";
      const abs = path.resolve(ws!.root, String(b.path));
      const rel = path.relative(ws!.root, abs);
      if (rel.startsWith("..") || path.isAbsolute(rel)) return `${abs} is outside the workspace ${ws!.root}`;
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return `no file ${rel}`;
      return { path: rel, line: Number(b.line ?? 0) || 0, endLine: Number(b.endLine ?? 0) || 0 };
    },
    symbol: (b) => (b.name ? { name: String(b.name), layout: b.layout ?? null } : "symbol needs name"),
    search: (b) => (typeof b.query === "string" ? { query: b.query } : "search needs query"),
  };
  if (!ARGS[cmd]) return fail(400, `unknown cmd "${cmd}": use diff, file, symbol, search, shot or state`);
  if (!ws) return fail(409, "no workspace is open in codeviz; open one on its Workspace page");
  const a = ARGS[cmd](b);
  if (typeof a === "string") return fail(400, a);

  // Symbols need the symbol table; wait for the pass (a first index of a big repo can take minutes).
  if (cmd === "symbol" || cmd === "search") {
    for (let i = 0; i < 180 && server.phase !== "ready" && server.phase !== "error"; i++) await new Promise((r) => setTimeout(r, 1000));
    if (server.phase !== "ready") return fail(503, `the index is not ready (${server.phase}); try again later`);
  }
  if (b.focus) {
    if (w.isMinimized()) w.restore();
    w.show();
    w.focus();
  } else if (!w.isVisible() || w.isMinimized()) w.showInactive();
  const r = await js(`window.codeviz.project(${JSON.stringify(cmd)}, ${JSON.stringify({ ...a, newTab: !!b.newTab })})`);
  if (r?.error && cmd === "diff" && /unknown revision|bad revision|ambiguous argument/.test(r.error)) {
    return fail(400, `bad rev "${(a as any).rev}": not a commit, range or "worktree" in ${ws.root}`);
  }
  if (r?.error) return fail(/^no symbol|^no file|not found/i.test(r.error) ? 404 : 400, r.error);
  return ok({ cmd, workspace: ws.root, ...r });
}

function openDiff(w: BrowserWindow, rev: string): Promise<unknown> {
  return w.webContents.executeJavaScript(`window.codeviz.diff(${JSON.stringify(rev)}, ${JSON.stringify(args.layout ?? null)})`);
}

/** Waits for the symbol pass, types the query or opens the cluster, and saves the window as a PNG. */
async function shot(w: BrowserWindow, out: string): Promise<void> {
  const js = (s: string) => w.webContents.executeJavaScript(s);
  // The page's console and errors, so a shot run shows what went wrong.
  w.webContents.on("console-message", (e) => console.log(`[page] ${e.level}: ${e.message}`));
  for (let i = 0; i < 600; i++) {
    const phase = await js("window.codeviz && window.codeviz.phase()");
    if (phase === "ready" || phase === "error" || phase === "none") break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (args.query !== undefined) {
    await js(`window.codeviz.search(${JSON.stringify(args.query)})`);
  }
  if (args.cluster !== undefined) {
    await js(`window.codeviz.cluster(${JSON.stringify(args.cluster)}, ${JSON.stringify(args.layout ?? null)})`);
  }
  if (args.diff !== undefined) {
    await js(`window.codeviz.diff(${JSON.stringify(args.diff)}, ${JSON.stringify(args.layout ?? null)})`);
  }
  if (args.eval !== undefined) await js(`(async () => { ${args.eval} })()`);
  await new Promise((r) => setTimeout(r, 400));
  const img = await w.webContents.capturePage();
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, img.toPNG());
  console.log(`codeviz: wrote ${out}`);
  app.quit();
}

if (!args.shot && !app.requestSingleInstanceLock()) {
  app.exit(0);
} else {
  app.on("second-instance", (_e, argv) => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
    const rev = parseArgs(argv.slice(1)).diff;
    if (rev !== undefined) openDiff(win, rev).catch((e) => console.error(e));
  });
  app.whenReady().then(start);
}
app.on("window-all-closed", () => app.quit());
app.on("will-quit", (e) => {
  removeServerFile();
  if (!server) return;
  e.preventDefault();
  const s = server;
  server = undefined as unknown as Server;
  s.close().finally(() => app.exit(0));
});
