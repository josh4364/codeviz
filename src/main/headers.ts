// Compile commands for headers. A header has no entry of its own in a compile db,
// and many are not self-contained: Jolt's use JPH_NAMESPACE_BEGIN from Jolt.h,
// which every Jolt source includes first. Parsed alone they come out as garbage.
//
// So each header gets the command of a source that reaches it, plus `-include`
// for what that source includes before it, along the include chain: the context
// it has in a real build. Sources are walked in order, each include depth first;
// a header is walked once, but takes the shortest context of every chain that
// reaches it (a self-contained header gets none from the source next to it). Includes are read as text
// (no macros); ones under `#if` are followed but are not put in front of others,
// so a platform's include never lands in another's context.

import * as fs from "fs";
import * as path from "path";

export interface CdbEntry {
  directory: string;
  file: string;
  command?: string;
  arguments?: string[];
  output?: string;
}

const HEADER_EXTS = new Set([".h", ".hh", ".hpp", ".hxx", ".inl"]);
const C_EXTS = new Set([".c"]);

/** Splits a compile command the way a POSIX shell would, for quotes and backslashes. */
export function shellWords(cmd: string): string[] {
  const out: string[] = [];
  let word: string | null = null;
  let quote = "";
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) {
      if (c === quote) quote = "";
      else if (c === "\\" && quote === '"' && i + 1 < cmd.length) word += cmd[++i];
      else word += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      word ??= "";
    } else if (c === "\\" && i + 1 < cmd.length) {
      word = (word ?? "") + cmd[++i];
    } else if (/\s/.test(c)) {
      if (word !== null) out.push(word);
      word = null;
    } else word = (word ?? "") + c;
  }
  if (word !== null) out.push(word);
  return out;
}

export function entryArgs(e: CdbEntry): string[] {
  return e.arguments ?? shellWords(e.command ?? "");
}

export const INCLUDE_FLAGS = ["-isystem", "-iquote", "-idirafter", "-I"];

/** The folders an entry searches: quoted includes look in `quote` first, then `angled`. */
function searchDirs(e: CdbEntry): { quote: string[]; angled: string[] } {
  const args = entryArgs(e);
  const quote: string[] = [];
  const angled: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const flag = INCLUDE_FLAGS.find((f) => args[i].startsWith(f));
    if (!flag) continue;
    const value = args[i] === flag ? args[++i] : args[i].slice(flag.length);
    if (!value) continue;
    (flag === "-iquote" ? quote : angled).push(path.resolve(e.directory, value));
  }
  return { quote, angled };
}

interface Include {
  name: string;
  angled: boolean;
  // Under an #if (an include guard does not count).
  conditional: boolean;
}

const INCLUDE_RE = /^\s*#\s*include\s*([<"])([^>"]+)[>"]/;
const DIRECTIVE_RE = /^\s*#\s*(\w+)\s*(\w*)/;

/** A file's #include lines in order, and whether each sits under an #if. */
function readIncludes(file: string): Include[] {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: Include[] = [];
  let depth = 0;
  // An include guard (#ifndef X, then #define X) wraps the file; it is depth 0.
  let guard = "";
  let guardDepth = -1;
  let pendingGuard = "";
  let directives = 0;
  for (const line of text.split("\n")) {
    const inc = INCLUDE_RE.exec(line);
    if (inc) {
      directives++;
      pendingGuard = "";
      out.push({ name: inc[2], angled: inc[1] === "<", conditional: depth - (guardDepth >= 0 ? 1 : 0) > 0 });
      continue;
    }
    const d = DIRECTIVE_RE.exec(line);
    if (!d) continue;
    directives++;
    const [, word, arg] = d;
    if (word === "if" || word === "ifdef" || word === "ifndef") {
      depth++;
      pendingGuard = word === "ifndef" && directives === 1 ? arg : "";
    } else if (word === "define" && pendingGuard && arg === pendingGuard) {
      guard = pendingGuard;
      guardDepth = depth;
      pendingGuard = "";
    } else if (word === "endif") {
      if (guard && depth === guardDepth) guardDepth = -1;
      depth = Math.max(0, depth - 1);
      pendingGuard = "";
    } else if (word !== "pragma") pendingGuard = "";
  }
  return out;
}

/**
 * A compile db entry for each header in `wanted` that some source in `entries`
 * reaches: the source's command on the header, as a header of the source's
 * language, with `-include` for its context. Headers no source reaches get none
 * (clangd guesses their flags from a nearby file).
 */
export function headerEntries(entries: CdbEntry[], wanted: Set<string>): CdbEntry[] {
  const out = new Map<string, CdbEntry>();
  const includes = new Map<string, Include[]>();
  const exists = new Map<string, boolean>();
  const isFile = (p: string) => {
    let v = exists.get(p);
    if (v === undefined) {
      v = fs.existsSync(p) && fs.statSync(p).isFile();
      exists.set(p, v);
    }
    return v;
  };
  // A header is walked once, from the first source that reaches it.
  const seen = new Set<string>();
  const contextLength = new Map<string, number>();

  for (const e of entries) {
    const source = path.resolve(e.directory, e.file);
    if (HEADER_EXTS.has(path.extname(source).toLowerCase())) continue;
    const dirs = searchDirs(e);
    const lang = C_EXTS.has(path.extname(source).toLowerCase()) ? "c-header" : "c++-header";
    const base = baseArgs(entryArgs(e), e, source);

    const resolve = (from: string, inc: Include): string | null => {
      const list = inc.angled ? dirs.angled : [path.dirname(from), ...dirs.quote, ...dirs.angled];
      for (const d of list) {
        const p = path.join(d, inc.name);
        if (isFile(p)) return p;
      }
      return null;
    };

    // `context`: what the build has included before `file`, as -include values.
    const walk = (file: string, context: string[]) => {
      let incs = includes.get(file);
      if (!incs) includes.set(file, (incs = readIncludes(file)));
      const before = [...context];
      for (const inc of incs) {
        const p = resolve(file, inc);
        if (p && HEADER_EXTS.has(path.extname(p).toLowerCase())) {
          if (wanted.has(p) && before.length < (contextLength.get(p) ?? Infinity)) {
            contextLength.set(p, before.length);
            out.set(p, {
              directory: e.directory,
              file: p,
              arguments: [...base, "-x", lang, ...before.flatMap((b) => ["-include", b]), p],
            });
          }
          if (!seen.has(p)) {
            seen.add(p);
            walk(p, before);
          }
        }
        if (!inc.conditional) before.push(p ?? inc.name);
      }
    };
    walk(source, []);
  }
  return [...out.values()];
}

/** The source's command without its input, output and dependency-file flags. */
function baseArgs(args: string[], e: CdbEntry, source: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-o" || a === "-MF" || a === "-MQ" || a === "-MT") {
      i++;
      continue;
    }
    if (a === "-c" || a === "-MD" || a === "-MMD") continue;
    if (path.resolve(e.directory, a) === source) continue;
    out.push(a);
  }
  return out;
}
