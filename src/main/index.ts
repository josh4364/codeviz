// The symbol table: every function and type under the chosen roots, read from
// clangd one file at a time, cached on disk by file mtime, merged by USR.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";
import { CallItem, Clangd, DocumentSymbol } from "./clangd";
import { chosenExternals, External, externalOf, listSourceFiles, rootOf, WorkspaceConfig, workspaceDir, writeFilteredCdb } from "./workspace";

export type SymKind = "function" | "method" | "struct" | "class" | "union" | "enum" | "typedef";

/** One declaration or definition of a symbol in one file. */
interface RawSym {
  id: string;
  name: string;
  kind: SymKind;
  container: string;
  signature: string;
  // First line of the whole declaration, the line of the name, the last line.
  startLine: number;
  line: number;
  endLine: number;
  def: boolean;
  // Identifiers its interface mentions: a function's signature, a record's field
  // types, a typedef's text. The reverse of this is the "API surface" of a type.
  refs: string[];
}

interface FileEntry {
  mtimeMs: number;
  size: number;
  syms: RawSym[];
}

interface CacheFile {
  version: number;
  files: Record<string, FileEntry>;
}

export interface SymLocation {
  file: string;
  startLine: number;
  line: number;
  endLine: number;
  def: boolean;
}

/** A symbol merged across every file that declares or defines it. */
export interface Sym {
  id: string;
  name: string;
  kind: SymKind;
  container: string;
  signature: string;
  root: string;
  locs: SymLocation[];
}

export interface IndexStatus {
  phase: "idle" | "starting" | "symbols" | "ready" | "error";
  filesDone: number;
  filesTotal: number;
  symbols: number;
  cdbEntries: number;
  clangdIndex: { active: boolean; percentage?: number; message?: string };
  error?: string;
}

interface SearchKey {
  lower: string;
  loose: string;
  qualified: string;
  qualifiedLower: string;
  qualifiedLoose: string;
}

const CACHE_VERSION = 3;
const IDENT = /[A-Za-z_]\w*/g;
const NOT_REFS = new Set([
  "const", "volatile", "struct", "union", "enum", "typedef", "unsigned", "signed", "static",
  "inline", "extern", "restrict", "void", "char", "short", "int", "long", "float", "double", "_Bool",
  "bool", "auto", "register", "class", "typename", "template",
]);

/** The identifiers in `text` that may name a symbol, without keywords and `skip`. */
export function identifiers(text: string, skip?: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(IDENT)) {
    if (!NOT_REFS.has(m[0]) && m[0] !== skip) out.add(m[0]);
  }
  return [...out];
}

/** Field types of a record, nested records included. */
function fieldTypes(s: DocumentSymbol, out: string[]): string[] {
  for (const c of s.children ?? []) {
    if (c.detail) out.push(c.detail);
    fieldTypes(c, out);
  }
  return out;
}
const RECORD_DETAIL: Record<string, SymKind> = {
  struct: "struct",
  class: "class",
  union: "union",
  enum: "enum",
  "type alias": "typedef",
};
// When a typedef and its record share a USR, the record kind wins.
const KIND_RANK: Record<SymKind, number> = {
  struct: 0,
  class: 0,
  union: 0,
  enum: 0,
  function: 1,
  method: 1,
  typedef: 2,
};

const LSP_NAMESPACE = 3;
const LSP_CLASS = 5;
const LSP_METHOD = 6;
const LSP_CONSTRUCTOR = 9;
const LSP_ENUM = 10;
const LSP_FUNCTION = 12;
const LSP_STRUCT = 23;
// clangd lists a macro expansion that holds declarations (JPH_NAMESPACE_BEGIN) as a String.
const LSP_MACRO = 15;

function symKind(s: DocumentSymbol): SymKind | null {
  switch (s.kind) {
    case LSP_FUNCTION:
      return "function";
    case LSP_METHOD:
    case LSP_CONSTRUCTOR:
      return "method";
    case LSP_ENUM:
      return "enum";
    case LSP_CLASS:
    case LSP_STRUCT:
      return RECORD_DETAIL[s.detail ?? ""] ?? (s.kind === LSP_STRUCT ? "struct" : "class");
    default:
      return null;
  }
}

/** Symbols worth listing, with their scope, flattened out of namespaces and classes. */
export function flatSymbols(symbols: DocumentSymbol[]): { s: DocumentSymbol; container: string; kind: SymKind }[] {
  const out: { s: DocumentSymbol; container: string }[] = [];
  collect(symbols, "", out);
  return out.map((o) => ({ ...o, kind: symKind(o.s)! }));
}

/**
 * Walks namespaces and records, and macro expansions outside records (a namespace
 * opened by a macro); a macro inside a record adds boilerplate (operator new).
 */
function collect(symbols: DocumentSymbol[], container: string, out: { s: DocumentSymbol; container: string }[], inRecord = false) {
  for (const s of symbols) {
    const kind = symKind(s);
    if (kind) out.push({ s, container });
    if (!s.children) continue;
    if (s.kind === LSP_NAMESPACE || s.kind === LSP_CLASS || s.kind === LSP_STRUCT) {
      collect(s.children, container ? `${container}::${s.name}` : s.name, out, s.kind !== LSP_NAMESPACE);
    } else if (s.kind === LSP_MACRO && !inRecord) {
      collect(s.children, container, out, false);
    }
  }
}

/** A definition has a body: a `{` between the name and the end of its range. */
function hasBody(lines: string[], s: DocumentSymbol): boolean {
  const { start } = s.selectionRange;
  const { end } = s.range;
  for (let l = start.line; l <= end.line && l < lines.length; l++) {
    const from = l === start.line ? start.character : 0;
    const to = l === end.line ? end.character : lines[l].length;
    if (lines[l].slice(from, to).includes("{")) return true;
  }
  return false;
}

export class SymbolIndex {
  readonly cfg: WorkspaceConfig;
  // The chosen externals at their current paths, found when the index starts.
  private externals: External[] = [];
  private dir: string;
  // Call hierarchy, old file versions for diffs, and the background index.
  private clangd: Clangd | null = null;
  // The symbol pass: no index, every core, so it neither waits on nor slows the background index.
  private reader: Clangd | null = null;
  private cache: CacheFile = { version: CACHE_VERSION, files: {} };
  private merged: Sym[] | null = null;
  private byId = new Map<string, Sym>();
  private byName = new Map<string, Sym[]>();
  private usedBy = new Map<string, Sym[]>();
  private byLoc = new Map<string, Sym>();
  private refs = new Map<string, Set<string>>();
  // Lowercased search text per symbol, made on first search. A rebuilt table has new Syms.
  private keys = new WeakMap<Sym, SearchKey>();
  private stopped = false;
  private scanning: Promise<void> | null = null;
  private again = false;
  status: IndexStatus = {
    phase: "idle",
    filesDone: 0,
    filesTotal: 0,
    symbols: 0,
    cdbEntries: 0,
    clangdIndex: { active: false },
  };

  constructor(cfg: WorkspaceConfig) {
    this.cfg = cfg;
    this.dir = workspaceDir(cfg.root);
  }

  private cachePath(): string {
    return path.join(this.dir, "symbols.json");
  }

  private loadCache(): void {
    try {
      const c: CacheFile = JSON.parse(fs.readFileSync(this.cachePath(), "utf8"));
      if (c.version === CACHE_VERSION) this.cache = c;
    } catch {
      // No cache yet.
    }
  }

  private saveCache(): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = this.cachePath() + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.cache));
    fs.renameSync(tmp, this.cachePath());
  }

  async start(): Promise<void> {
    try {
      this.status.phase = "starting";
      this.loadCache();
      this.externals = chosenExternals(this.cfg);
      this.status.cdbEntries = writeFilteredCdb(this.cfg, this.externals, this.dir);
      this.clangd = new Clangd(this.cfg.root, this.dir);
      await this.clangd.initialize(this.cfg.root);
      this.reader = new Clangd(this.cfg.root, this.dir, { jobs: os.cpus().length, backgroundIndex: false });
      await this.reader.initialize(this.cfg.root);
      void this.warm();
      await this.scan();
    } catch (e: any) {
      this.status.phase = "error";
      this.status.error = String(e?.stack ?? e);
      console.error(e);
    }
  }

  /**
   * clangd loads its index from disk only when it first opens a file. With every
   * file in our cache nothing is opened, so open one now; until the load ends,
   * call hierarchy answers come back empty.
   */
  private async warm(): Promise<void> {
    const file = listSourceFiles(this.cfg, []).find((f) => /\.(c|cc|cpp|cxx)$/.test(f));
    if (file && this.clangd) await this.clangd.fileSymbols(file, () => []).catch(() => {});
  }

  /** Runs a pass. A call during a pass queues one more pass after it, so changes made meanwhile are read. */
  scan(): Promise<void> {
    if (this.scanning) {
      this.again = true;
      return this.scanning;
    }
    this.scanning = (async () => {
      try {
        do {
          this.again = false;
          await this.pass();
        } while (this.again && !this.stopped);
      } catch (e: any) {
        this.status.phase = "error";
        this.status.error = String(e?.stack ?? e);
        console.error(e);
      } finally {
        this.scanning = null;
      }
    })();
    return this.scanning;
  }

  /**
   * Re-reads files edited since the last pass, so blocks cut from the file on
   * disk use its current lines. Waits only once the first pass is done.
   */
  async fresh(): Promise<void> {
    if (this.status.phase === "ready") await this.scan();
  }

  /** Re-reads every file whose mtime or size changed; drops files that are gone. */
  private async pass(): Promise<void> {
    if (!this.reader) return;
    const files = listSourceFiles(this.cfg, this.externals);
    const live = new Set(files);
    let gone = 0;
    for (const f of Object.keys(this.cache.files)) {
      if (!live.has(f)) {
        delete this.cache.files[f];
        gone++;
      }
    }
    const stale = files.filter((f) => {
      const st = fs.statSync(f);
      const c = this.cache.files[f];
      return !c || c.mtimeMs !== st.mtimeMs || c.size !== st.size;
    });
    if (stale.length === 0 && gone === 0 && this.merged) return;
    // Biggest first, so no large file is left running alone at the end.
    const size = new Map(stale.map((f) => [f, fs.statSync(f).size]));
    stale.sort((a, b) => size.get(b)! - size.get(a)!);
    this.merged = null;
    this.status.phase = "symbols";
    this.status.filesTotal = stale.length;
    this.status.filesDone = 0;

    const workers = os.cpus().length;
    let next = 0;
    let sinceSave = 0;
    const work = async () => {
      while (next < stale.length && !this.stopped) {
        const file = stale[next++];
        try {
          this.cache.files[file] = await this.readFile(file);
        } catch (e) {
          console.error(`codeviz: ${file}: ${e}`);
        }
        this.status.filesDone++;
        this.merged = null;
        if (++sinceSave >= 200) {
          sinceSave = 0;
          this.saveCache();
        }
      }
    };
    await Promise.all(Array.from({ length: workers }, work));
    if (this.stopped) return;
    this.saveCache();
    this.table();
    this.status.phase = "ready";
  }

  private async readFile(file: string): Promise<FileEntry> {
    const st = fs.statSync(file);
    const lines = fs.readFileSync(file, "utf8").split("\n");
    let picked: { s: DocumentSymbol; container: string }[] = [];
    const { details } = await this.reader!.fileSymbols(file, (symbols) => {
      collect(symbols, "", picked);
      return picked.map((p) => p.s);
    });
    const syms: RawSym[] = [];
    for (const { s, container } of picked) {
      const kind = symKind(s)!;
      let id = details.get(s)?.usr ?? "";
      // symbolInfo on a typedef of a builtin answers with the builtin's USR.
      if (!id || (kind === "typedef" && !id.endsWith(s.name))) id = `codeviz:T@${container}::${s.name}`;
      const isRecord = kind !== "function" && kind !== "method" && kind !== "typedef";
      const startLine = s.range.start.line + 1;
      const endLine = s.range.end.line + 1;
      let iface = "";
      if (kind === "function" || kind === "method") iface = s.detail ?? "";
      else if (kind === "typedef") iface = lines.slice(startLine - 1, endLine).join("\n");
      else if (kind !== "enum") iface = fieldTypes(s, []).join("\n");
      syms.push({
        id,
        name: s.name,
        kind,
        container,
        signature: kind === "function" || kind === "method" ? (s.detail ?? "") : "",
        startLine,
        line: s.selectionRange.start.line + 1,
        endLine,
        def: kind === "typedef" || (isRecord ? (s.children?.length ?? 0) > 0 || hasBody(lines, s) : hasBody(lines, s)),
        refs: identifiers(iface, s.name),
      });
    }
    return { mtimeMs: st.mtimeMs, size: st.size, syms };
  }

  private table(): Sym[] {
    if (this.merged) return this.merged;
    const byId = new Map<string, Sym>();
    this.refs = new Map();
    for (const [file, entry] of Object.entries(this.cache.files)) {
      const rel = this.rel(file);
      for (const r of entry.syms) {
        let s = byId.get(r.id);
        if (!s) {
          s = {
            id: r.id,
            name: r.name,
            kind: r.kind,
            container: r.container,
            signature: r.signature,
            root: rootOf(this.cfg, this.externals, file),
            locs: [],
          };
          byId.set(r.id, s);
        } else if (KIND_RANK[r.kind] < KIND_RANK[s.kind]) {
          s.kind = r.kind;
        }
        if (!s.signature && r.signature) s.signature = r.signature;
        const dup = s.locs.find((l) => l.file === rel && l.line === r.line);
        if (!dup) s.locs.push({ file: rel, startLine: r.startLine, line: r.line, endLine: r.endLine, def: r.def });
        let refs = this.refs.get(r.id);
        if (!refs) this.refs.set(r.id, (refs = new Set()));
        for (const n of r.refs) refs.add(n);
      }
    }
    for (const s of byId.values()) {
      s.locs.sort((a, b) => Number(b.def) - Number(a.def) || a.file.localeCompare(b.file));
      // A symbol belongs to the folder of its definition, when it has one.
      const def = s.locs.find((l) => l.def);
      if (def) s.root = rootOf(this.cfg, this.externals, this.abs(def.file));
    }
    this.merged = [...byId.values()];
    this.byId = byId;
    this.byName = new Map();
    this.usedBy = new Map();
    this.byLoc = new Map();
    for (const s of this.merged) {
      push(this.byName, s.name, s);
      for (const n of this.refs.get(s.id) ?? []) push(this.usedBy, n, s);
      for (const l of s.locs) this.byLoc.set(`${l.file}:${l.line}`, s);
    }
    const hasDef = (s: Sym) => Number(s.locs[0]?.def ?? false);
    for (const list of this.byName.values()) list.sort((a, b) => hasDef(b) - hasDef(a));
    this.status.symbols = this.merged.length;
    return this.merged;
  }

  /** A location path: relative to the repo, or under an external its label ("sdl3-3.4.0-dev/include/SDL3/SDL_gpu.h"). */
  rel(file: string): string {
    const x = externalOf(this.externals, file);
    if (x) return path.join(x.label, path.relative(x.dir, file));
    return path.relative(this.cfg.root, file);
  }

  /** The absolute path of a location path from rel(). */
  abs(rel: string): string {
    for (const x of this.externals) if (rel.startsWith(x.label + "/")) return path.join(x.dir, rel.slice(x.label.length + 1));
    return path.resolve(this.cfg.root, rel);
  }

  get(id: string): Sym | undefined {
    this.table();
    return this.byId.get(id);
  }

  /** Symbols with this exact name; the one with a definition first. */
  named(name: string): Sym[] {
    this.table();
    return this.byName.get(name) ?? [];
  }

  /** Symbols whose interface mentions `name` (see RawSym.refs). */
  usersOf(name: string): Sym[] {
    this.table();
    return this.usedBy.get(name) ?? [];
  }

  refsOf(s: Sym): Set<string> {
    this.table();
    return this.refs.get(s.id) ?? new Set();
  }

  /** The symbol whose name sits at this line of this file (path relative to the root). */
  at(file: string, line: number): Sym | undefined {
    this.table();
    return this.byLoc.get(`${file}:${line}`);
  }

  /** The symbol tree of `text` as the content of `file` (for diffs of old versions). */
  async documentSymbols(file: string, text: string): Promise<DocumentSymbol[]> {
    return this.clangd ? this.clangd.documentSymbols(file, text) : [];
  }

  /** Callers and callees from clangd's index, as symbols of this table. */
  async calls(s: Sym): Promise<{ callers: Sym[]; callees: Sym[] }> {
    const loc = s.locs.find((l) => l.def) ?? s.locs[0];
    if (!this.clangd || !loc) return { callers: [], callees: [] };
    const file = this.abs(loc.file);
    const text = fs.readFileSync(file, "utf8").split("\n")[loc.line - 1] ?? "";
    const r = await this.clangd.callHierarchy(file, { line: loc.line - 1, character: Math.max(0, text.indexOf(s.name)) });
    const toSyms = (items: CallItem[]) => {
      const out = new Map<string, Sym>();
      for (const it of items) {
        const rel = this.rel(fileURLToPath(it.uri));
        const hit = this.at(rel, it.selectionRange.start.line + 1) ?? this.named(it.name)[0];
        if (hit && hit !== s) out.set(hit.id, hit);
      }
      return [...out.values()];
    };
    return { callers: toSyms(r.incoming), callees: toSyms(r.outgoing) };
  }

  /**
   * Case-insensitive partial match on the name, or on the qualified name when
   * the query holds `::`. Exact, then prefix, then word start, then substring,
   * then a substring with every `_` ignored (`type_db` finds `ecs_typedb_t`).
   */
  search(query: string, kinds: Set<SymKind> | null, limit: number): { total: number; results: Sym[] } {
    const q = query.trim().toLowerCase();
    if (!q) return { total: 0, results: [] };
    const qualified = q.includes("::");
    const loose = q.replaceAll("_", "");
    const hits: { s: Sym; score: number }[] = [];
    for (const s of this.table()) {
      if (kinds && !kinds.has(s.kind)) continue;
      const key = this.key(s);
      const text = qualified ? key.qualified : s.name;
      const lower = qualified ? key.qualifiedLower : key.lower;
      const at = lower.indexOf(q);
      let score: number;
      if (at < 0) {
        if (!loose || !(qualified ? key.qualifiedLoose : key.loose).includes(loose)) continue;
        score = 4;
      } else if (lower === q) score = 0;
      else if (at === 0) score = 1;
      else if (wordStart(text, lower, q)) score = 2;
      else score = 3;
      hits.push({ s, score });
    }
    hits.sort(
      (a, b) =>
        a.score - b.score ||
        a.s.name.length - b.s.name.length ||
        a.s.name.localeCompare(b.s.name),
    );
    return { total: hits.length, results: hits.slice(0, limit).map((h) => h.s) };
  }

  private key(s: Sym): SearchKey {
    let k = this.keys.get(s);
    if (!k) {
      const qualified = s.container ? `${s.container}::${s.name}` : s.name;
      const lower = s.name.toLowerCase();
      const qualifiedLower = qualified.toLowerCase();
      k = {
        lower,
        loose: lower.replaceAll("_", ""),
        qualified,
        qualifiedLower,
        qualifiedLoose: qualifiedLower.replaceAll("_", ""),
      };
      this.keys.set(s, k);
    }
    return k;
  }

  refreshStatus(): IndexStatus {
    if (this.clangd) this.status.clangdIndex = this.clangd.progress;
    this.status.symbols = this.merged?.length ?? this.status.symbols;
    return this.status;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await Promise.all([this.clangd?.shutdown(), this.reader?.shutdown()]);
    this.clangd = null;
    this.reader = null;
  }
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  const list = m.get(k);
  if (list) list.push(v);
  else m.set(k, [v]);
}

/** The query starts at a `_`/`:` boundary or a lower-to-upper camel step. */
function wordStart(text: string, lower: string, q: string): boolean {
  for (let at = lower.indexOf(q); at >= 0; at = lower.indexOf(q, at + 1)) {
    const prev = text[at - 1];
    if (prev === "_" || prev === ":") return true;
    if (/[a-z0-9]/.test(prev) && /[A-Z]/.test(text[at])) return true;
  }
  return false;
}
