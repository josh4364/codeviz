// A cluster: one symbol and everything related to it, each with the block of
// source that shows it (comments included), for the cluster view.
//
// A type brings its API surface: functions whose signature names it, records
// with a field of it, typedefs of it. A function brings the types in its
// signature and its direct callers and callees.

import * as fs from "fs";
import { blockRange, expandTabs, dedent } from "./blocks";
import { identifiers, Sym, SymbolIndex, SymKind } from "./index";
import { settings } from "./settings";

export type Relation = "self" | "returns" | "takes" | "field" | "alias" | "type" | "caller" | "callee";

export interface Block {
  file: string;
  // 1-based, inclusive, comments included.
  start: number;
  end: number;
  text: string;
}

export interface ClusterItem {
  sym: Sym;
  rel: Relation;
  block: Block | null;
}

export interface Cluster {
  focus: string;
  items: ClusterItem[];
  // Items left out past the cluster cap (settings).
  dropped: number;
  // Callers and callees were asked while clangd was still loading its index; some may be missing.
  partial: boolean;
  // Identifiers in the blocks that name a symbol, for clicking.
  links: Record<string, { id: string; kind: SymKind }>;
}

const REL_ORDER: Relation[] = ["self", "returns", "field", "alias", "type", "callee", "caller", "takes"];
const TYPE_KINDS = new Set<SymKind>(["struct", "class", "union", "enum", "typedef"]);

export function isType(s: Sym): boolean {
  return TYPE_KINDS.has(s.kind);
}

export async function buildCluster(index: SymbolIndex, focus: Sym): Promise<Cluster> {
  let partial = false;
  const rels = new Map<string, { sym: Sym; rel: Relation }>();
  const add = (sym: Sym, rel: Relation) => {
    if (!rels.has(sym.id)) rels.set(sym.id, { sym, rel });
  };
  add(focus, "self");

  if (isType(focus)) {
    const word = new RegExp(`\\b${focus.name}\\b`);
    for (const u of index.usersOf(focus.name)) {
      if (u.kind === "function" || u.kind === "method") {
        // The return type is what comes before the parameter list.
        const ret = u.signature.slice(0, u.signature.indexOf("("));
        add(u, word.test(ret) ? "returns" : "takes");
      } else if (u.kind === "typedef") add(u, "alias");
      // Nested unnamed records ("(anonymous struct)") are part of their parent's block.
      else if (!u.name.startsWith("(")) add(u, "field");
    }
  } else {
    for (const n of index.refsOf(focus)) {
      const t = index.named(n).find(isType);
      if (t) add(t, "type");
    }
    const loading = index.refreshStatus().clangdIndex.active;
    const { callers, callees } = await index.calls(focus);
    partial = loading || index.refreshStatus().clangdIndex.active;
    for (const c of callees) add(c, "callee");
    for (const c of callers) add(c, "caller");
  }

  // Over the cluster cap (settings), the rarer relations are kept first.
  const all = [...rels.values()].sort((a, b) => REL_ORDER.indexOf(a.rel) - REL_ORDER.indexOf(b.rel));
  const kept = all.slice(0, settings().clusterMaxBoxes);
  const files = new Map<string, string[]>();
  const items = kept.map(({ sym, rel }) => ({ sym, rel, block: block(index, sym, files) }));

  const links: Cluster["links"] = {};
  for (const it of items) {
    if (!it.block) continue;
    for (const n of identifiers(it.block.text)) {
      if (n in links) continue;
      const s = index.named(n)[0];
      if (s) links[n] = { id: s.id, kind: s.kind };
    }
  }
  return { focus: focus.id, items, dropped: all.length - kept.length, partial, links };
}

/** The definition (or else the first declaration) with its leading and trailing comments. */
function block(index: SymbolIndex, s: Sym, files: Map<string, string[]>): Block | null {
  const loc = s.locs[0];
  if (!loc) return null;
  let lines = files.get(loc.file);
  if (!lines) {
    try {
      lines = fs.readFileSync(index.abs(loc.file), "utf8").split("\n");
    } catch {
      return null;
    }
    files.set(loc.file, lines);
  }
  const { start, end } = blockRange(lines, loc.startLine, loc.endLine);
  const text = dedent(lines.slice(start - 1, end).map(expandTabs)).join("\n");
  return { file: loc.file, start, end, text };
}
