// codeviz-mcp: a stdio MCP server that lets Claude Code drive a running codeviz
// window (the "projector"). It speaks newline-delimited JSON-RPC 2.0 (MCP's
// stdio transport: initialize, notifications/initialized, ping, tools/list,
// tools/call) and forwards each tool to the app's POST /api/view, found
// through $XDG_STATE_HOME/codeviz/server.json. Every call carries `repo`: the
// git toplevel of this process's cwd, so the app switches to that workspace.
//
// Run: node dist/main/mcp.js (the package's bin/codeviz-mcp, or scripts/mcp.sh).
// Register: claude mcp add --scope user codeviz -- codeviz-mcp

import { execFileSync, spawn } from "child_process";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";

interface Tool {
  name: string;
  description: string;
  inputSchema: object;
}

interface Content {
  type: string;
  [k: string]: unknown;
}

const PROTOCOL = "2025-06-18";
const NOT_RUNNING = "codeviz is not running; call open or start it from the launcher";

const NEW_TAB = { type: "boolean", description: "Open a fresh tab instead of replacing the ▶ projector tab (keeps the previous view around)." };
const FOCUS = { type: "boolean", description: "Raise and focus the codeviz window. Default false: the window is shown without stealing focus." };

const TOOLS: Tool[] = [
  {
    name: "open",
    description:
      "Start the codeviz projector (a code viewer window beside the user's editor) for this repo, if it is not running, and return its state. " +
      "codeviz is started manually: call this only when the user asks for codeviz, or asks to be shown code, and the other tools report it is not running.",
    inputSchema: { type: "object", properties: { focus: FOCUS }, additionalProperties: false },
  },
  {
    name: "show_diff",
    description:
      "Show a commit, range or the uncommitted changes in the user's codeviz window, as side-by-side boxes per changed function or type. " +
      "Use it when the user asks to see changes, to show a change before asking the user to decide, or after finishing work (rev \"worktree\" for uncommitted work, \"HEAD\" for the last commit) so the user can inspect it. " +
      "rev: a sha, \"A..B\", \"main...branch\" (a PR) or \"worktree\".",
    inputSchema: {
      type: "object",
      properties: {
        rev: { type: "string", description: "A sha, A..B, main...branch, or \"worktree\"." },
        layout: { type: "string", enum: ["impact", "change", "diff-file", "diff-folder"], description: "Box layout; default impact (biggest changes first)." },
        newTab: NEW_TAB,
        focus: FOCUS,
      },
      required: ["rev"],
      additionalProperties: false,
    },
  },
  {
    name: "show_file",
    description:
      "Show a source file in the user's codeviz window with the given line range highlighted and framed. " +
      "Use it to point the user at the code you are talking about or working on (\"look at this function\"), or at code that matters for a decision. " +
      "C/C++ is coloured and its symbol names are clickable; markdown opens rendered; other files show as plain text.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Repo-relative or absolute path inside the repo." },
        line: { type: "integer", description: "First line of the range to highlight (1-based). Omit to show the top." },
        endLine: { type: "integer", description: "Last line of the range (default: line)." },
        newTab: NEW_TAB,
        focus: FOCUS,
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "show_symbol",
    description:
      "Show a C/C++ symbol's cluster in the user's codeviz window: a function with its callers, callees and signature types, or a type with its API surface (functions that take or return it, records holding it). " +
      "Use it to show the user how a function or type fits in before a design decision, or when the user asks how something is used.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "The symbol's name (a function, struct, class, enum or typedef); qualified (ns::name) for C++ when ambiguous." },
        layout: { type: "string", enum: ["relation", "file", "folder", "kind", "affinity"], description: "Box layout; default the user's last choice." },
        newTab: NEW_TAB,
        focus: FOCUS,
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "search",
    description: "Show a symbol search (functions and types whose name contains the query) in the user's codeviz window, so the user can pick from the results.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" }, focus: FOCUS },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "screenshot",
    description: "Capture what the user's codeviz window shows now, as a PNG image (also saved; the path is returned). Use it to check what the user sees after a show_* call.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Where to save the PNG (default under ~/.cache/codeviz/shots/)." } },
      additionalProperties: false,
    },
  },
  {
    name: "state",
    description: "Report codeviz's state: whether it runs, the open workspace, the index phase (symbol tools need \"ready\"), the current view and tab.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

// ---- the app ----------------------------------------------------------------

function serverFile(): string {
  const state = process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
  return path.join(state, "codeviz", "server.json");
}

/** The running app's port, or null when server.json is missing or its process is gone. */
function appPort(): number | null {
  try {
    const { port, pid } = JSON.parse(fs.readFileSync(serverFile(), "utf8"));
    process.kill(pid, 0);
    return Number(port);
  } catch {
    return null;
  }
}

function request(port: number, method: string, p: string, body?: unknown, timeoutMs = 300_000): Promise<{ code: number; body: any }> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      { host: "127.0.0.1", port, method, path: p, headers: data ? { "content-type": "application/json" } : {}, timeout: timeoutMs },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (text += c));
        res.on("end", () => {
          try {
            resolve({ code: res.statusCode ?? 0, body: JSON.parse(text) });
          } catch {
            reject(new Error(`codeviz answered ${res.statusCode} with no JSON`));
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("codeviz did not answer in time")));
    req.on("error", reject);
    req.end(data);
  });
}

/** The git toplevel of the cwd (the repo the agent works in), else the cwd. `npm run mcp` runs in this checkout; INIT_CWD is where it was called. */
function repoRoot(): string {
  const cwd = process.env.INIT_CWD || process.cwd();
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return cwd;
  }
}

/** POST /api/view; null when the app is not running. */
async function view(body: object): Promise<{ code: number; body: any } | null> {
  const port = appPort();
  if (port === null) return null;
  try {
    return await request(port, "POST", "/api/view", { ...body, repo: repoRoot() });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ECONNREFUSED") return null;
    throw e;
  }
}

/** The launcher: $CODEVIZ_BIN, the package's bin/codeviz next to this file, the checkout's scripts/run.sh, or codeviz on PATH. */
function launcher(): string {
  if (process.env.CODEVIZ_BIN) return process.env.CODEVIZ_BIN;
  // Packaged: $out/lib/codeviz/dist/main/mcp.js -> $out/bin/codeviz.
  const packaged = path.resolve(__dirname, "..", "..", "..", "..", "bin", "codeviz");
  if (fs.existsSync(packaged)) return packaged;
  const dev = path.resolve(__dirname, "..", "..", "scripts", "run.sh");
  if (fs.existsSync(dev)) return dev;
  return "codeviz";
}

async function open(focus: boolean): Promise<Content[]> {
  let r = await view({ cmd: "state" });
  if (!r) {
    const bin = launcher();
    const child = spawn(bin, ["--workspace", repoRoot()], { detached: true, stdio: "ignore" });
    let failed: Error | null = null;
    child.on("error", (e) => (failed = e));
    child.unref();
    // A dev launch builds first; give it a minute.
    for (let i = 0; i < 240 && !r; i++) {
      if (failed) return text(`could not start ${bin}: ${(failed as Error).message}; set CODEVIZ_BIN to the codeviz launcher`, true);
      await new Promise((res) => setTimeout(res, 250));
      r = await view({ cmd: "state" }).catch(() => null);
    }
    if (!r) return text(`started ${bin} but it did not answer within 60 s`, true);
  }
  if (focus) await view({ cmd: "state", focus: true });
  return result(r);
}

// ---- MCP --------------------------------------------------------------------

function text(t: string, isError = false): Content[] & { isError?: boolean } {
  const c: Content[] & { isError?: boolean } = [{ type: "text", text: t }];
  if (isError) c.isError = true;
  return c;
}

function result(r: { code: number; body: any } | null): Content[] & { isError?: boolean } {
  if (!r) return text(NOT_RUNNING, true);
  if (r.body?.error) return text(`codeviz: ${r.body.error}`, true);
  return text(JSON.stringify(r.body));
}

async function callTool(name: string, a: any): Promise<Content[] & { isError?: boolean }> {
  const common = { newTab: !!a.newTab, focus: !!a.focus };
  switch (name) {
    case "open":
      return open(!!a.focus);
    case "show_diff":
      return result(await view({ cmd: "diff", rev: a.rev, layout: a.layout, ...common }));
    case "show_file":
      return result(await view({ cmd: "file", path: a.path ? path.resolve(repoRoot(), a.path) : a.path, line: a.line, endLine: a.endLine, ...common }));
    case "show_symbol":
      return result(await view({ cmd: "symbol", name: a.name, layout: a.layout, ...common }));
    case "search":
      return result(await view({ cmd: "search", query: a.query, focus: !!a.focus }));
    case "state": {
      const r = await view({ cmd: "state" });
      return r ? result(r) : text(JSON.stringify({ running: false, message: NOT_RUNNING }));
    }
    case "screenshot": {
      const r = await view({ cmd: "shot", path: a.path });
      if (!r || r.body?.error) return result(r);
      const png = fs.readFileSync(r.body.path).toString("base64");
      return [
        { type: "image", data: png, mimeType: "image/png" },
        { type: "text", text: `saved ${r.body.path} (${r.body.width}x${r.body.height})` },
      ];
    }
  }
  return text(`unknown tool ${name}`, true);
}

function reply(id: unknown, payload: { result?: unknown; error?: { code: number; message: string } }): void {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, ...payload }) + "\n");
}

async function handle(msg: any): Promise<void> {
  const { id, method, params } = msg;
  // A notification (no id) gets no answer.
  const isRequest = id !== undefined && id !== null;
  try {
    switch (method) {
      case "initialize":
        return reply(id, {
          result: {
            protocolVersion: typeof params?.protocolVersion === "string" ? params.protocolVersion : PROTOCOL,
            capabilities: { tools: {} },
            serverInfo: { name: "codeviz", version: "0.1.0" },
            instructions:
              "codeviz is a code viewer window the user keeps open beside the terminal. Use its show_* tools to put code, a symbol's cluster or a diff in front of the user: when they ask, when seeing it helps a decision, and after finishing work (show_diff worktree or HEAD). It is started manually: call open only when the user wants it.",
          },
        });
      case "ping":
        return reply(id, { result: {} });
      case "tools/list":
        return reply(id, { result: { tools: TOOLS } });
      case "tools/call": {
        const content = await callTool(String(params?.name), params?.arguments ?? {});
        return reply(id, { result: { content: [...content], isError: !!content.isError } });
      }
      default:
        if (isRequest) reply(id, { error: { code: -32601, message: `method not found: ${method}` } });
    }
  } catch (e) {
    if (isRequest) {
      // A tool that failed is a tool result with isError, not a protocol error.
      if (method === "tools/call") reply(id, { result: { content: text(`codeviz: ${(e as Error).message}`), isError: true } });
      else reply(id, { error: { code: -32603, message: String((e as Error).message) } });
    }
  }
}

let buf = "";
let toolQueue: Promise<void> = Promise.resolve();
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      reply(null, { error: { code: -32700, message: "parse error" } });
      continue;
    }
    // Tool calls run one at a time, so a show_* and the screenshot after it never race; the rest answer at once.
    if (msg?.method === "tools/call") toolQueue = toolQueue.then(() => handle(msg));
    else void handle(msg);
  }
});
process.stdin.on("end", () => process.exit(0));
