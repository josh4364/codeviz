// A small C/C++ highlighter. Identifiers that name a symbol of the table become
// links, coloured by the symbol's kind.

import { TYPE_KINDS } from "./dom.js";

const KEYWORDS = new Set(
  (
    "auto break case const continue default do else enum extern for goto if inline register restrict return " +
    "sizeof static struct switch typedef union volatile while _Alignas _Alignof _Atomic _Generic _Noreturn " +
    "_Static_assert _Thread_local alignas alignof bool catch class constexpr const_cast decltype delete " +
    "dynamic_cast explicit export false friend mutable namespace new noexcept nullptr operator private " +
    "protected public reinterpret_cast static_assert static_cast template this throw true try typeid " +
    "typename using virtual NULL"
  ).split(" "),
);
const BUILTIN_TYPES = new Set(
  "void char short int long float double signed unsigned _Bool size_t ssize_t uint8_t uint16_t uint32_t uint64_t int8_t int16_t int32_t int64_t uintptr_t intptr_t u8 u16 u32 u64 s8 s16 s32 s64 f32 f64 b32".split(
    " ",
  ),
);

// One alternative per token class, tried in order at each position.
const TOKEN = new RegExp(
  [
    String.raw`(\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|(?![\s\S])))`, // 1 comment
    String.raw`("(?:[^"\\\n]|\\.)*"?|'(?:[^'\\\n]|\\.)*'?)`, // 2 string or char
    String.raw`(^[ \t]*#[^\n]*)`, // 3 preprocessor line
    String.raw`(\b(?:0[xX][0-9a-fA-F']+|\d[\d']*\.?\d*(?:[eE][+-]?\d+)?)[uUlLfF]*\b)`, // 4 number
    String.raw`([A-Za-z_]\w*)`, // 5 identifier
  ].join("|"),
  "gm",
);

/**
 * Splits `text` into lines of tokens { col, text, cls, id? } for the canvas
 * renderer. `cls` names a colour ("" is plain text); `id` marks a link to a
 * symbol. `links` maps identifier -> { id, kind }; `self` is the box's own
 * symbol, which is coloured but not a link.
 */
export function tokenize(text, links, self) {
  const lines = [[]];
  let col = 0;
  const emit = (str, cls, id) => {
    const parts = str.split("\n");
    parts.forEach((part, i) => {
      if (i > 0) {
        lines.push([]);
        col = 0;
      }
      if (!part) return;
      const t = { col, text: part, cls };
      if (id) t.id = id;
      lines[lines.length - 1].push(t);
      col += part.length;
    });
  };
  let from = 0;
  for (const m of text.matchAll(TOKEN)) {
    if (m.index > from) emit(text.slice(from, m.index), "");
    from = m.index + m[0].length;
    if (m[1]) emit(m[0], "com");
    else if (m[2]) emit(m[0], "str");
    else if (m[3]) emit(m[0], "pp");
    else if (m[4]) emit(m[0], "num");
    else {
      const w = m[5];
      const link = links[w];
      if (link) {
        const kind = TYPE_KINDS.has(link.kind) ? "type" : "fn";
        if (link.id === self) emit(w, kind);
        else emit(w, kind, link.id);
      } else if (KEYWORDS.has(w)) emit(w, "kw");
      else if (BUILTIN_TYPES.has(w)) emit(w, "bt");
      else if (/^[A-Z][A-Z0-9_]+$/.test(w)) emit(w, "mac");
      else emit(w, "");
    }
  }
  if (from < text.length) emit(text.slice(from), "");
  return lines;
}

/** The identifiers in `text` (for the affinity layout's edges). */
export function identifiersIn(text) {
  return new Set(text.match(/[A-Za-z_]\w*/g) ?? []);
}
