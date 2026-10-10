// Boxes for the commit view, made from /api/diff: a commit card, summary boxes
// for added and deleted files, and one side-by-side box per change. Rows use
// render.js's body format (tokens and bands on the monospace grid).
//
//   modified  the whole block before | after, each top-aligned; removed lines red, added green
//   added     a slim "new" column | the code
//   deleted   the code | a slim "deleted" column
//   moved     like modified, the header says where from

import { tokenize } from "./code.js";
import { BOX_PAD, HEAD_H, LINE_H, metrics } from "./render.js";

const LN = 5; // line number columns
const GUTTER = 3;
const SLIM = 11; // width of the "new" / "deleted" column
const MAX_CODE_COLS = 140;
const MAX_BODY_LINES = 14;
const KIND_SHORT = { function: "fn", method: "method", struct: "struct", class: "class", union: "union", enum: "enum", typedef: "typedef" };
const CHANGE_COLOUR = { added: "add", deleted: "del", modified: "mod", moved: "move" };
const STATUS = { A: ["A", "add"], D: ["D", "del"], M: ["M", "mod"], R: ["R", "move"] };

/** All boxes of a diff; the first is the commit card. */
export function diffBoxes(d) {
  const firstBoxOf = new Map();
  const entryBoxes = d.entries.map((e) => entryBox(e, d.links, d));
  for (const b of entryBoxes) if (!firstBoxOf.has(b.block.file)) firstBoxOf.set(b.block.file, b.id);
  const boxes = [cardBox(d, firstBoxOf)];
  if (d.deletedFiles.length) boxes.push(deletedFilesBox(d));
  if (d.addedFiles.length) boxes.push(addedFilesBox(d, firstBoxOf));
  for (const g of d.fileGroups) boxes.push(fileGroupBox(g, d));
  return [...boxes, ...entryBoxes];
}

// ---- a change ---------------------------------------------------------------

/** The link that opens a markdown file rendered (views/doc.js), at the diff's head, or its base when deleted. */
export function docLink(d, path, deleted = false) {
  if (!/\.(md|markdown)$/i.test(path)) return undefined;
  return `doc:${deleted ? d.base : (d.head ?? "")}|${path}`;
}

function entryBox(e, links, d) {
  const slimLeft = e.change === "added";
  const slimRight = e.change === "deleted";
  const codeCols = (lines) => Math.min(MAX_CODE_COLS, Math.max(20, ...lines.map(([, t]) => t.length)));
  const leftW = slimLeft ? SLIM : LN + 1 + codeCols(e.before);
  const rightX = leftW + GUTTER;
  const rightW = slimRight ? SLIM : LN + 1 + codeCols(e.after);
  const before = tokenizeSide(e.before, links);
  const after = tokenizeSide(e.after, links);
  // Each side is its whole block, top-aligned on its own like a cluster box;
  // the lines the diff touched are tinted.
  const left = sideLines(e, 0);
  const right = sideLines(e, 1);
  const rows = [];
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const row = { tokens: [], bands: [] };
    if (!slimLeft) put(row, left[i], e.before, before, 0, leftW, "delBg");
    if (!slimRight) put(row, right[i], e.after, after, rightX, rightW, "addBg");
    row.tokens.push({ col: leftW + 1, text: "│", cls: "ln" });
    rows.push(row);
  }
  if (slimLeft || slimRight) {
    const col = slimLeft ? 0 : rightX;
    const word = slimLeft ? "new" : "deleted";
    rows.forEach((row, i) => {
      row.bands.unshift({ col, cols: SLIM, colour: slimLeft ? "addBg" : "delBg" });
      if (i === 0) row.tokens.push({ col: col + Math.floor((SLIM - word.length) / 2), text: word, cls: slimLeft ? "add" : "del", bold: true });
    });
  }

  const first = (e.after[0] ?? e.before[0])?.[0] ?? 1;
  const kind = e.kind ?? (e.type === "file" ? "file" : "code");
  const tags = [{ text: e.change === "modified" && e.type !== "symbol" ? "changed" : e.change, fill: true, colour: CHANGE_COLOUR[e.change] }];
  if (e.added) tags.push({ text: `+${e.added}`, colour: "add" });
  if (e.removed) tags.push({ text: `−${e.removed}`, colour: "del" });
  return box({
    id: e.id,
    name: e.name,
    kind,
    accent: CHANGE_COLOUR[e.change],
    header: {
      chip: KIND_SHORT[kind] ?? kind,
      chipColour: e.kind ? undefined : "#8a909c",
      name: e.name,
      nameId: e.type === "symbol" ? links[e.name]?.id : e.type === "file" ? docLink(d, e.file, e.change === "deleted") : undefined,
      tags,
      right: e.oldFile ? `${e.oldFile} → ${e.file}` : `${e.file}:${first}`,
    },
    rows,
    block: { file: e.file, start: first },
    change: e.type === "symbol" ? e.change : e.type,
    churn: e.added + e.removed,
  });
}

/** One side's cell of a row: a line number and its code from `col`, tinted when changed, or "⋯" between hunks. */
function put(row, item, lines, tokens, col, width, band) {
  if (!item) return;
  if (item.gap) {
    row.bands.push({ col, cols: width, colour: "foldBg" });
    row.tokens.push({ col: col + LN + 1, text: "⋯", cls: "fold", italic: true });
    return;
  }
  if (item.changed) row.bands.push({ col, cols: width, colour: band });
  const ln = String(lines[item.i][0]);
  row.tokens.push({ col: col + LN - 1 - ln.length, text: ln, cls: "ln" });
  for (const t of tokens[item.i] ?? []) {
    if (t.col + t.text.length > MAX_CODE_COLS) continue;
    row.tokens.push({ ...t, col: col + LN + 1 + t.col });
  }
}

/** Tokens per line of one side, tokenized as one text so comments that span lines stay comments. */
function tokenizeSide(lines, links) {
  if (!lines.length) return [];
  return tokenize(lines.map(([, t]) => t).join("\n"), links, null);
}

/**
 * One side's lines in order (side 0 before, 1 after), each { i, changed }, with
 * { gap } where the entry skips between hunks. A line is changed unless the
 * alignment pairs it with an equal line on the other side.
 */
function sideLines(e, side) {
  const out = [];
  for (const r of e.rows) {
    if (r[0] === -2) {
      out.push({ gap: true });
      continue;
    }
    const i = r[side];
    if (i < 0) continue;
    const other = r[1 - side];
    const same = other >= 0 && e.before[r[0]][1].trimEnd() === e.after[r[1]][1].trimEnd();
    out.push({ i, changed: !same });
  }
  return out;
}

// ---- summaries --------------------------------------------------------------

function cardBox(d, firstBoxOf) {
  const rows = [];
  // A row of tokens one after another; `gap` puts spaces before a token.
  const line = (...tokens) => {
    let col = 0;
    const out = [];
    for (const t of tokens.filter(Boolean)) {
      col += t.gap ?? 0;
      out.push({ ...t, col });
      col += t.text.length;
    }
    rows.push({ tokens: out });
  };
  const one = d.commits.length === 1 ? d.commits[0] : null;
  if (one) {
    line({ text: one.subject.slice(0, 110), cls: "head", bold: true });
    line({ text: one.short, cls: "mac" }, { text: `  ${one.author} · ${new Date(one.date).toLocaleString()}`, cls: "dim" });
  } else if (d.head === null) {
    line({ text: "Working tree", cls: "head", bold: true });
    line({ text: "uncommitted changes against HEAD", cls: "dim" });
  } else {
    line({ text: d.label, cls: "head", bold: true });
    line({ text: `${d.commits.length} commits`, cls: "dim" });
  }
  if (d.body) {
    const body = d.body.split("\n").slice(1).filter((l, i, a) => l.trim() || (i > 0 && a[i - 1].trim()));
    if (body.length) rows.push({ tokens: [] });
    for (const l of body.slice(0, MAX_BODY_LINES)) line({ text: l.slice(0, 110), cls: "com" });
    if (body.length > MAX_BODY_LINES) line({ text: `… ${body.length - MAX_BODY_LINES} more lines`, cls: "fold", italic: true });
  }
  if (!one && d.commits.length > 1) {
    rows.push({ tokens: [] });
    for (const c of d.commits.slice(0, 15)) line({ text: c.short, cls: "mac" }, { text: `  ${c.subject.slice(0, 90)}`, cls: "" });
    if (d.commits.length > 15) line({ text: `… ${d.commits.length - 15} more`, cls: "fold", italic: true });
  }
  // Submodules whose commit moved: their range and commits; their files are in the list below.
  for (const s of d.submodules) {
    rows.push({ tokens: [] });
    const range = `${s.base.slice(0, 9)}..${s.head ? s.head.slice(0, 9) : "working tree"}`;
    line({ text: s.path, cls: "head", bold: true }, { text: range, cls: "mac", gap: 2 });
    if (s.missing) {
      line({ text: "a commit is not in the submodule's checkout, so its files are not shown", cls: "fold", italic: true });
      continue;
    }
    for (const c of s.commits.slice(0, 8)) line({ text: c.short, cls: "mac" }, { text: `  ${c.subject.slice(0, 90)}`, cls: "" });
    if (s.commits.length > 8) line({ text: `… ${s.commits.length - 8} more`, cls: "fold", italic: true });
  }

  const added = d.files.reduce((n, f) => n + f.added, 0);
  const removed = d.files.reduce((n, f) => n + f.removed, 0);
  const counts = {};
  for (const e of d.entries) if (e.type === "symbol") counts[e.change] = (counts[e.change] ?? 0) + 1;
  rows.push({ tokens: [] });
  line({ text: `${d.files.length} files`, cls: "head", bold: true }, { text: `+${added}`, cls: "add", gap: 2 }, { text: `−${removed}`, cls: "del", gap: 1 });
  const parts = ["modified", "added", "moved", "deleted"].filter((k) => counts[k]);
  if (parts.length) {
    line(...parts.flatMap((k, i) => [{ text: `${counts[k]} ${k}`, cls: CHANGE_COLOUR[k], gap: i ? 3 : 0 }]), { text: "symbols", cls: "dim", gap: 2 });
  }
  rows.push({ tokens: [] });

  const maxChurn = Math.max(1, ...d.files.map((f) => f.added + f.removed));
  const pathW = Math.min(70, Math.max(...d.files.map((f) => f.path.length), 10));
  for (const f of d.files.slice(0, 60)) {
    const [letter, colour] = STATUS[f.status];
    const target = firstBoxOf.get(f.path);
    const p = f.path.length > pathW ? `…${f.path.slice(-(pathW - 1))}` : f.path;
    const tokens = [
      { col: 0, text: letter, cls: colour, bold: true },
      { col: 2, text: p, cls: target ? "" : "dim", id: docLink(d, f.path, f.status === "D") ?? (target ? `goto:${target}` : undefined) },
    ];
    const stat = f.binary ? "binary" : `+${f.added} −${f.removed}`;
    tokens.push({ col: pathW + 4, text: stat, cls: f.binary ? "dim" : "ln" });
    const barCol = pathW + 16;
    // sqrt, so a one-line change still shows next to a rewrite.
    const bar = f.added + f.removed ? Math.max(1, Math.round(20 * Math.sqrt((f.added + f.removed) / maxChurn))) : 0;
    const green = Math.round((bar * f.added) / Math.max(1, f.added + f.removed));
    const bands = f.binary ? [] : [
      { col: barCol, cols: green, colour: "add" },
      { col: barCol + green, cols: bar - green, colour: "del" },
    ];
    rows.push({ tokens, bands });
  }
  if (d.files.length > 60) line({ text: `… ${d.files.length - 60} more files`, cls: "fold", italic: true });
  if (d.dropped) line({ text: `${d.dropped} smaller changes not shown`, cls: "fold", italic: true });

  return box({
    id: "diff:card",
    name: one ? one.short : d.label,
    kind: "commit",
    accent: "accent",
    header: { chip: one ? "commit" : d.head === null ? "worktree" : "range", chipColour: "#6aa8ff", name: one ? one.short : d.label, tags: [], right: "" },
    rows,
    summary: true,
    minCols: 60,
  });
}

function deletedFilesBox(d) {
  const rows = [];
  for (const f of d.deletedFiles) {
    rows.push({ tokens: [{ col: 0, text: f.path, cls: "del", id: docLink(d, f.path, true) }, { col: f.path.length + 2, text: `−${f.lines}`, cls: "ln" }] });
    const names = f.symbols.slice(0, 8);
    for (const n of names) rows.push({ tokens: [{ col: 4, text: n, cls: "dim" }] });
    if (f.symbols.length > names.length) rows.push({ tokens: [{ col: 4, text: `… ${f.symbols.length - names.length} more`, cls: "fold", italic: true }] });
  }
  const n = d.deletedFiles.length;
  return box({
    id: "diff:deleted-files",
    name: `Deleted ${n} file${n === 1 ? "" : "s"}`,
    kind: "files",
    accent: "del",
    header: { chip: "files", chipColour: "#f28b82", name: `Deleted ${n} file${n === 1 ? "" : "s"}`, tags: [], right: "" },
    rows,
    summary: true,
  });
}

function addedFilesBox(d, firstBoxOf) {
  const rows = d.addedFiles.map((f) => {
    const target = firstBoxOf.get(f.path);
    const tokens = [{ col: 0, text: f.path, cls: "add", id: docLink(d, f.path) ?? (target ? `goto:${target}` : undefined) }];
    tokens.push({ col: f.path.length + 2, text: `+${f.lines}${f.symbols ? ` · ${f.symbols} symbols` : ""}`, cls: "ln" });
    return { tokens };
  });
  const n = d.addedFiles.length;
  return box({
    id: "diff:added-files",
    name: `Added ${n} file${n === 1 ? "" : "s"}`,
    kind: "files",
    accent: "add",
    header: { chip: "files", chipColour: "#7ee2a0", name: `Added ${n} file${n === 1 ? "" : "s"}`, tags: [], right: "" },
    rows,
    summary: true,
  });
}

function fileGroupBox(g, d) {
  const pathW = Math.min(80, Math.max(...g.files.map((f) => f.path.length)));
  const rows = g.files.slice(0, 120).map((f) => ({
    tokens: [
      { col: 0, text: f.path.length > pathW ? `…${f.path.slice(-(pathW - 1))}` : f.path, cls: "", id: docLink(d, f.path) },
      { col: pathW + 2, text: `+${f.added}`, cls: "add" },
      { col: pathW + 10, text: `−${f.removed}`, cls: "del" },
    ],
  }));
  if (g.files.length > 120) rows.push({ tokens: [{ col: 0, text: `… ${g.files.length - 120} more`, cls: "fold", italic: true }] });
  const name = `${g.files.length} ${g.ext} files`;
  const added = g.files.reduce((n, f) => n + f.added, 0);
  const removed = g.files.reduce((n, f) => n + f.removed, 0);
  return box({
    id: `diff:group:${g.ext}`,
    name,
    kind: "files",
    accent: "mod",
    header: { chip: "files", chipColour: "#e6c07b", name, tags: [{ text: `+${added}`, colour: "add" }, { text: `−${removed}`, colour: "del" }], right: "" },
    rows,
    summary: true,
  });
}

/** A box sized to its rows. */
function box({ id, name, kind, accent, header, rows, block, change, churn = 0, summary = false, minCols = 24 }) {
  const m = metrics();
  let cols = minCols;
  for (const r of rows) {
    for (const t of r.tokens) cols = Math.max(cols, t.col + t.text.length);
    for (const b of r.bands ?? []) if (b.cols !== Infinity) cols = Math.max(cols, b.col + b.cols);
  }
  const headCols = header.name.length + 16 + header.tags.reduce((n, t) => n + t.text.length + 3, 0) + (header.right?.length ?? 0) * 0.8;
  cols = Math.max(cols, headCols * 0.85);
  return {
    id,
    sym: { name, kind },
    accent,
    header,
    rowCache: rows,
    block: block ?? { file: "", start: 0 },
    change: summary ? "summary" : change,
    churn,
    summary,
    refs: new Set(),
    w: Math.ceil(cols * m.charW + BOX_PAD * 2),
    h: Math.ceil(HEAD_H + Math.max(1, rows.length) * LINE_H + BOX_PAD * 2),
    x: 0,
    y: 0,
  };
}
