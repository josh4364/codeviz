// Dumps what clangd returns for some files: the documentSymbol tree and each
// symbol's USR. Use it to look at clangd's answers before building on them.
//
//   npm run probe -- [--workspace <repo>] [--depth <n>] <file>...
//
// It uses the saved config of --workspace (default: the last workspace) and the
// same filtered compile db and clangd index as the app.

import * as path from "path";
import { Clangd, DocumentSymbol, SymbolDetails } from "../src/main/clangd";
import { chosenExternals, loadStore, workspaceDir, writeFilteredCdb } from "../src/main/workspace";

const argv = process.argv.slice(2);
let root: string | undefined;
let depth = 1;
const files: string[] = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--workspace") root = path.resolve(argv[++i]);
  else if (argv[i] === "--depth") depth = Number(argv[++i]);
  else files.push(path.resolve(argv[i]));
}

const store = loadStore();
const cfg = store.workspaces[root ?? store.last ?? ""];
if (!cfg || files.length === 0) {
  console.error("usage: probe [--workspace <repo>] [--depth <n>] <file>...  (the workspace must be saved)");
  process.exit(1);
}

function dump(s: DocumentSymbol, details: Map<DocumentSymbol, SymbolDetails>, d: number): void {
  const lines = `L${s.range.start.line + 1}-${s.range.end.line + 1}`;
  console.log(`${"  ".repeat(d)}${s.kind} ${s.name} | ${s.detail ?? ""} | ${lines} | ${details.get(s)?.usr ?? ""}`);
  if (d < depth) for (const c of s.children ?? []) dump(c, details, d + 1);
}

function all(symbols: DocumentSymbol[], d = 0, out: DocumentSymbol[] = []): DocumentSymbol[] {
  for (const s of symbols) {
    out.push(s);
    if (d < depth) all(s.children ?? [], d + 1, out);
  }
  return out;
}

(async () => {
  const dir = workspaceDir(cfg.root);
  writeFilteredCdb(cfg, chosenExternals(cfg), dir);
  const clangd = new Clangd(cfg.root, dir);
  await clangd.initialize(cfg.root);
  for (const file of files) {
    const t = Date.now();
    const { symbols, details } = await clangd.fileSymbols(file, (s) => all(s));
    console.log(`${path.relative(cfg.root, file)}: ${symbols.length} top-level symbols, ${Date.now() - t} ms`);
    for (const s of symbols) dump(s, details, 0);
  }
  await clangd.shutdown();
})();
