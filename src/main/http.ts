// The local HTTP server: the UI's static files and a small JSON API.

import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import { AddressInfo } from "net";
import { buildCluster } from "./cluster";
import { buildDiff, fileAt, recentCommits } from "./diff";
import { identifiers, SymbolIndex, SymKind } from "./index";
import { externalCandidates, findCompileDbs, folderCandidates, loadStore, saveWorkspace, WorkspaceConfig } from "./workspace";
import { DEFAULTS, saveSettings, Settings, settings, settingsPath } from "./settings";

export interface ServerHooks {
  /** Shows a native folder picker; null when the user cancels or there is no window. */
  pickFolder?: () => Promise<string | null>;
  // After the settings are saved, with the old ones.
  settingsChanged?: (now: Settings, before: Settings) => void;
  /** Runs a projector command (POST /api/view); returns the HTTP code and JSON body. */
  view?: (body: any) => Promise<{ code: number; body: unknown }>;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

export class Server {
  private index: SymbolIndex | null = null;
  private http: http.Server;
  private uiDir: string;
  private hooks: ServerHooks;

  constructor(uiDir: string, hooks: ServerHooks = {}) {
    this.uiDir = uiDir;
    this.hooks = hooks;
    this.http = http.createServer((req, res) => {
      this.route(req, res).catch((e) => send(res, 500, { error: String(e?.message ?? e) }));
    });
  }

  listen(port: number): Promise<number> {
    return new Promise((resolve) => {
      this.http.listen(port, "127.0.0.1", () => resolve((this.http.address() as AddressInfo).port));
    });
  }

  /** Stops the current workspace's clangd and indexes `cfg` instead. */
  async openWorkspace(cfg: WorkspaceConfig): Promise<void> {
    if (this.index) await this.index.stop();
    saveWorkspace(cfg);
    this.index = new SymbolIndex(cfg);
    void this.index.start();
  }

  /** The open workspace, or null. */
  get workspace(): WorkspaceConfig | null {
    return this.index?.cfg ?? null;
  }

  /** The index phase ("starting", "symbols", "ready", "error"), or null with no workspace. */
  get phase(): string | null {
    return this.index?.refreshStatus().phase ?? null;
  }

  async close(): Promise<void> {
    if (this.index) await this.index.stop();
    this.http.close();
  }

  private async route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const p = url.pathname;

    if (p === "/api/state" && req.method === "GET") {
      const store = loadStore();
      return send(res, 200, {
        workspace: this.index?.cfg ?? null,
        status: this.index?.refreshStatus() ?? null,
        recent: Object.keys(store.workspaces),
        canPickFolder: !!this.hooks.pickFolder,
      });
    }

    if (p === "/api/search" && req.method === "GET") {
      if (!this.index) return send(res, 409, { error: "no workspace open" });
      const kinds = url.searchParams.get("kinds");
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 500), 5000);
      const t = performance.now();
      const r = this.index.search(
        url.searchParams.get("q") ?? "",
        kinds ? new Set(kinds.split(",") as SymKind[]) : null,
        limit,
      );
      return send(res, 200, { ...r, ms: Math.round((performance.now() - t) * 10) / 10 });
    }

    if (p === "/api/cluster" && req.method === "GET") {
      if (!this.index) return send(res, 409, { error: "no workspace open" });
      await this.index.fresh();
      const id = url.searchParams.get("id");
      const name = url.searchParams.get("name");
      const focus = id ? this.index.get(id) : name ? this.index.named(name)[0] : undefined;
      if (!focus) return send(res, 404, { error: `no symbol ${id ?? name}` });
      const t = performance.now();
      const c = await buildCluster(this.index, focus);
      return send(res, 200, { ...c, ms: Math.round(performance.now() - t) });
    }

    if (p === "/api/file" && req.method === "GET") {
      if (!this.index) return send(res, 409, { error: "no workspace open" });
      try {
        const root = this.index.cfg.root;
        const rel = path.relative(root, path.resolve(root, url.searchParams.get("path") ?? ""));
        const text = await fileAt(root, url.searchParams.get("rev") ?? "", rel);
        // ?links=1: the identifiers that name a symbol, so the UI can make them clickable.
        const links: Record<string, { id: string; kind: SymKind }> = {};
        if (url.searchParams.get("links")) {
          for (const n of new Set(identifiers(text))) {
            const s = this.index.named(n)[0];
            if (s) links[n] = { id: s.id, kind: s.kind };
          }
        }
        return send(res, 200, { text, path: rel, links });
      } catch (e) {
        return send(res, 404, { error: String((e as Error).message) });
      }
    }

    if (p === "/api/commits" && req.method === "GET") {
      if (!this.index) return send(res, 409, { error: "no workspace open" });
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 60), 500);
      return send(res, 200, await recentCommits(this.index.cfg.root, limit));
    }

    if (p === "/api/diff" && req.method === "GET") {
      if (!this.index) return send(res, 409, { error: "no workspace open" });
      const t = performance.now();
      const d = await buildDiff(this.index, url.searchParams.get("rev") ?? "");
      return send(res, 200, { ...d, ms: Math.round(performance.now() - t) });
    }

    if (p === "/api/settings" && req.method === "GET") {
      return send(res, 200, { settings: settings(), defaults: DEFAULTS, path: settingsPath() });
    }

    if (p === "/api/settings" && req.method === "POST") {
      const before = settings();
      const now = saveSettings(await readJson(req));
      this.hooks.settingsChanged?.(now, before);
      return send(res, 200, { settings: now, defaults: DEFAULTS, path: settingsPath() });
    }

    if (p === "/api/workspace/inspect" && req.method === "POST") {
      const body = await readJson(req);
      const root = path.resolve(String(body.root ?? ""));
      if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
        return send(res, 400, { error: `not a folder: ${root}` });
      }
      const compileDbs = findCompileDbs(root);
      const saved = loadStore().workspaces[root];
      const compileDb: string | undefined = body.compileDb ?? saved?.compileDb ?? compileDbs[0];
      return send(res, 200, {
        root,
        compileDbs,
        compileDb: compileDb ?? null,
        folders: compileDb ? folderCandidates(root, compileDb) : [],
        externals: compileDb ? externalCandidates(root, compileDb) : [],
        roots: saved?.roots ?? [],
        chosenExternals: saved?.externals ?? [],
      });
    }

    if (p === "/api/workspace/open" && req.method === "POST") {
      const body = await readJson(req);
      const cfg: WorkspaceConfig = {
        root: path.resolve(String(body.root)),
        compileDb: String(body.compileDb),
        roots: (body.roots as string[]).filter(Boolean),
        externals: ((body.externals ?? []) as string[]).filter(Boolean),
      };
      if (cfg.roots.length === 0) return send(res, 400, { error: "choose at least one folder" });
      await this.openWorkspace(cfg);
      return send(res, 200, { ok: true });
    }

    if (p === "/api/rescan" && req.method === "POST") {
      if (!this.index) return send(res, 409, { error: "no workspace open" });
      void this.index.scan();
      return send(res, 200, { ok: true });
    }

    if (p === "/api/view" && req.method === "POST") {
      if (!this.hooks.view) return send(res, 501, { error: "no window to drive" });
      let body;
      try {
        body = await readJson(req);
      } catch {
        return send(res, 400, { error: "the body is not JSON" });
      }
      const r = await this.hooks.view(body);
      return send(res, r.code, r.body);
    }

    if (p === "/api/pick-folder" && req.method === "POST") {
      if (!this.hooks.pickFolder) return send(res, 501, { error: "no folder picker" });
      return send(res, 200, { path: await this.hooks.pickFolder() });
    }

    if (req.method === "GET" && !p.startsWith("/api/")) {
      const file = path.join(this.uiDir, p === "/" ? "index.html" : path.normalize(p));
      if (!file.startsWith(this.uiDir) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        return send(res, 404, { error: "not found" });
      }
      res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
      fs.createReadStream(file).pipe(res);
      return;
    }

    send(res, 404, { error: "not found" });
  }
}

function send(res: http.ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function readJson(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
  });
}
