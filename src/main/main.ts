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
//
// One app runs at a time (except --shot); a second launch forwards --diff to
// it and focuses its window.

import { app, BrowserWindow, dialog } from "electron";
import * as fs from "fs";
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

function parseArgs(argv: string[]): Args {
  const args: Args = { port: 0 };
  for (let i = 0; i < argv.length; i++) {
    const next = () => argv[++i];
    switch (argv[i]) {
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
    }
  }
  return args;
}

// The window class and name the desktop entry's StartupWMClass matches.
app.commandLine.appendSwitch("class", "codeviz");
app.setName("codeviz");

const args = parseArgs(process.argv.slice(1));
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
  });
  const port = await server.listen(args.port);
  const url = `http://127.0.0.1:${port}/`;
  console.log(`codeviz: serving ${url}`);

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
  if (!server) return;
  e.preventDefault();
  const s = server;
  server = undefined as unknown as Server;
  s.close().finally(() => app.exit(0));
});
