// clangd as a child process, spoken to over LSP on stdio.

import { ChildProcess, spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { pathToFileURL } from "url";
import {
  createMessageConnection,
  MessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-jsonrpc/node";

export interface LspRange {
  start: { line: number; character: number };
  end: { line: number; character: number };
}

export interface DocumentSymbol {
  name: string;
  detail?: string;
  kind: number;
  range: LspRange;
  selectionRange: LspRange;
  children?: DocumentSymbol[];
}

export interface SymbolDetails {
  name: string;
  containerName?: string;
  usr?: string;
  id?: string;
}

export interface CallItem {
  name: string;
  uri: string;
  range: LspRange;
  selectionRange: LspRange;
}

export interface IndexProgress {
  active: boolean;
  percentage?: number;
  message?: string;
}

/**
 * clangd reads $XDG_CONFIG_HOME/clangd/config.yaml. Ours: no unused-include
 * checks, and the background index skips headers given as compile db entries
 * (their symbols reach it through the sources that include them).
 */
const CONFIG = `Diagnostics:
  UnusedIncludes: None
  MissingIncludes: None
---
If:
  PathMatch: .*\\.(h|hh|hpp|hxx|inl)
Index:
  Background: Skip
`;

export class Clangd {
  private proc: ChildProcess;
  private conn: MessageConnection;
  private versions = new Map<string, number>();
  // One open document per file at a time: a diff opens the same path with old and new text.
  private locks = new Map<string, Promise<unknown>>();
  progress: IndexProgress = { active: false };

  /** cdbDir holds the filtered compile_commands.json; clangd puts its index there too. */
  constructor(rootDir: string, cdbDir: string, opts: { jobs?: number; backgroundIndex?: boolean } = {}) {
    const configHome = path.join(cdbDir, "config");
    fs.mkdirSync(path.join(configHome, "clangd"), { recursive: true });
    fs.writeFileSync(path.join(configHome, "clangd", "config.yaml"), CONFIG);
    const jobs = opts.jobs ?? Math.max(2, Math.floor(os.cpus().length / 2));
    this.proc = spawn(
      "clangd",
      [
        `--compile-commands-dir=${cdbDir}`,
        `--background-index=${opts.backgroundIndex ?? true}`,
        `-j=${jobs}`,
        "--limit-results=0",
        "--header-insertion=never",
        "--pch-storage=memory",
        // The compile db names gcc from the Nix store; let clangd ask it for system includes.
        "--query-driver=**",
        "--log=error",
      ],
      { cwd: rootDir, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, XDG_CONFIG_HOME: configHome } },
    );
    // clangd may exit before the last didClose or exit message is written.
    this.proc.stdin!.on("error", () => {});
    this.proc.stderr!.on("data", (d) => process.stderr.write(`[clangd] ${d}`));
    this.conn = createMessageConnection(
      new StreamMessageReader(this.proc.stdout!),
      new StreamMessageWriter(this.proc.stdin!),
    );
    this.conn.onRequest("window/workDoneProgress/create", () => null);
    this.conn.onNotification("$/progress", (p: any) => {
      if (p.token !== "backgroundIndexProgress") return;
      const v = p.value;
      if (v.kind === "begin" || v.kind === "report") {
        this.progress = { active: true, percentage: v.percentage, message: v.message };
      } else if (v.kind === "end") {
        this.progress = { active: false };
      }
    });
    this.conn.onNotification("textDocument/publishDiagnostics", () => {});
    this.conn.listen();
  }

  async initialize(rootDir: string): Promise<void> {
    await this.conn.sendRequest("initialize", {
      processId: process.pid,
      rootUri: pathToFileURL(rootDir).href,
      capabilities: {
        window: { workDoneProgress: true },
        textDocument: {
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          callHierarchy: {},
        },
      },
    });
    this.conn.sendNotification("initialized", {});
  }

  /** Runs `fn` once no other call holds `file` open. */
  private async exclusive<T>(file: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(file) ?? Promise.resolve();
    const run = prev.catch(() => {}).then(fn);
    this.locks.set(file, run);
    try {
      return await run;
    } finally {
      if (this.locks.get(file) === run) this.locks.delete(file);
    }
  }

  private open(file: string, text?: string): string {
    const uri = pathToFileURL(file).href;
    const version = (this.versions.get(uri) ?? 0) + 1;
    this.versions.set(uri, version);
    const ext = file.slice(file.lastIndexOf(".") + 1);
    const languageId = ext === "c" || ext === "h" ? "c" : "cpp";
    this.conn.sendNotification("textDocument/didOpen", {
      textDocument: { uri, languageId, version, text: text ?? fs.readFileSync(file, "utf8") },
    });
    return uri;
  }

  private close(uri: string): void {
    this.conn.sendNotification("textDocument/didClose", { textDocument: { uri } }).catch(() => {});
  }

  /**
   * Opens a file, returns its symbol hierarchy and a USR for each requested
   * position, then closes it. `pick` chooses which symbols need a USR.
   */
  async fileSymbols(
    file: string,
    pick: (symbols: DocumentSymbol[]) => DocumentSymbol[],
  ): Promise<{ symbols: DocumentSymbol[]; details: Map<DocumentSymbol, SymbolDetails> }> {
    return this.exclusive(file, () => this.fileSymbolsNow(file, pick));
  }

  private async fileSymbolsNow(
    file: string,
    pick: (symbols: DocumentSymbol[]) => DocumentSymbol[],
  ): Promise<{ symbols: DocumentSymbol[]; details: Map<DocumentSymbol, SymbolDetails> }> {
    const uri = this.open(file);
    try {
      const symbols: DocumentSymbol[] =
        (await this.conn.sendRequest("textDocument/documentSymbol", { textDocument: { uri } })) ?? [];
      const details = new Map<DocumentSymbol, SymbolDetails>();
      await Promise.all(
        pick(symbols).map(async (s) => {
          const info: SymbolDetails[] | null = await this.conn.sendRequest("textDocument/symbolInfo", {
            textDocument: { uri },
            position: s.selectionRange.start,
          });
          if (info && info.length > 0) details.set(s, info[0]);
        }),
      );
      return { symbols, details };
    } finally {
      this.close(uri);
    }
  }

  /** The symbol tree of `text` as if it were the content of `file` (an old version, say). */
  documentSymbols(file: string, text: string): Promise<DocumentSymbol[]> {
    return this.exclusive(file, async () => {
      const uri = this.open(file, text);
      try {
        return (await this.conn.sendRequest("textDocument/documentSymbol", { textDocument: { uri } })) ?? [];
      } finally {
        this.close(uri);
      }
    });
  }

  /** Incoming and outgoing calls of the function at `pos`, from the background index. */
  callHierarchy(
    file: string,
    pos: { line: number; character: number },
  ): Promise<{ incoming: CallItem[]; outgoing: CallItem[] }> {
    return this.exclusive(file, () => this.callHierarchyNow(file, pos));
  }

  private async callHierarchyNow(
    file: string,
    pos: { line: number; character: number },
  ): Promise<{ incoming: CallItem[]; outgoing: CallItem[] }> {
    const uri = this.open(file);
    try {
      const items: CallItem[] | null = await this.conn.sendRequest("textDocument/prepareCallHierarchy", {
        textDocument: { uri },
        position: pos,
      });
      if (!items || items.length === 0) return { incoming: [], outgoing: [] };
      const item = items[0];
      const [inc, out] = await Promise.all([
        this.conn.sendRequest("callHierarchy/incomingCalls", { item }) as Promise<{ from: CallItem }[] | null>,
        (this.conn.sendRequest("callHierarchy/outgoingCalls", { item }) as Promise<{ to: CallItem }[] | null>).catch(
          () => null,
        ),
      ]);
      return { incoming: (inc ?? []).map((c) => c.from), outgoing: (out ?? []).map((c) => c.to) };
    } finally {
      this.close(uri);
    }
  }

  async shutdown(): Promise<void> {
    try {
      await Promise.race([
        this.conn.sendRequest("shutdown"),
        new Promise((r) => setTimeout(r, 2000)),
      ]);
      await this.conn.sendNotification("exit");
    } catch {
      // clangd already gone.
    }
    this.conn.dispose();
    this.proc.kill();
  }
}
