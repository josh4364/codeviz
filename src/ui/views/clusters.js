// Cluster view: a pannable 2D world of outlined source boxes, drawn on a canvas
// by render.js. A tab holds one or more clusters (a symbol and everything
// related to it, from /api/cluster).
//
//   click a name        open its cluster in a new tab
//   shift-click a name  add its cluster to this tab, outside the others; the camera glides over
//   click a box         select it
//   numpad .            frame the selected box (or the tab's focus)
//   Home, F             fit everything
//
// The projector (an agent driving the app over POST /api/view) opens its views
// with { projector: true }: they replace the one projector tab, marked ▶,
// instead of adding tabs; { newTab: true } keeps the old one as a plain tab.
//
// A commit tab (openDiff) holds the boxes of a diff (diffboxes.js) instead,
// with its own layouts; names in it still open symbol clusters.

import { $, api, el, highlight, showMenu } from "../dom.js";
import { identifiersIn } from "../code.js";
import { diffBoxes, fileBox } from "../diffboxes.js";
import { DIFF_LAYOUTS, layout, LAYOUTS, placeNear } from "../layout.js";
import { navigating } from "../nav.js";
import { renderMarkdown } from "../markdown.js";
import { BOX_PAD, HEAD_H, LINE_H, metrics, Renderer } from "../render.js";

const MAX_COLS = 160;
const FRAME_PAD = 28;
const FRAME_LABEL = 30;
const MIN_SCALE = 0.02;
const MAX_SCALE = 2.5;
const KIND_SHORT = { function: "fn", method: "method", struct: "struct", class: "class", union: "union", enum: "enum", typedef: "typedef" };

const state = {
  tabs: [],
  active: null,
  layout: localStorage.getItem("codeviz.layout") || "relation",
  diffLayout: localStorage.getItem("codeviz.diffLayout") || "impact",
  cam: { x: 0, y: 0, s: 1 },
  anim: 0,
  nextTab: 1,
};
let shell;
let renderer;

export function initClusters(app) {
  shell = app;
  renderer = new Renderer($("cl-canvas"));
  const sel = $("cl-layout");
  syncLayoutSelect(null);
  sel.onchange = () => setLayout(sel.value);
  $("cl-fit").onclick = () => fitAll(true);
  initCamera();
  initFind();
  $("cl-tabs").addEventListener("click", onTabsClick);
  $("cl-tabs").addEventListener("contextmenu", onTabsMenu);
  // Repo links inside a doc open that file at the same revision.
  $("cl-doc").addEventListener("click", (e) => {
    const a = e.target.closest("a[data-path]");
    if (!a) return;
    e.preventDefault();
    openDoc(a.dataset.path, activeTab()?.doc?.rev ?? "");
  });
  $("cl-tabs").addEventListener("pointerdown", onTabDrag);
  $("cl-tabs").addEventListener("auxclick", (e) => {
    const t = e.target.closest("[data-tab]");
    if (t && e.button === 1) closeTab(Number(t.dataset.tab));
  });
  document.addEventListener("keydown", (e) => {
    if ($("view-clusters").hidden || e.target.closest?.("input, select")) return;
    // With num lock off the numpad's . reports "Delete"; the code is the same.
    if (e.code === "NumpadDecimal") frameSelected();
    else if (e.key === "Home" || e.key === "f" || e.key === "F") fitAll(true);
    else return;
    e.preventDefault();
  });
}

export function showClusters() {
  renderTabs();
  renderer.resize();
}

export function setLayout(name) {
  if (DIFF_LAYOUTS[name]) {
    state.diffLayout = name;
    localStorage.setItem("codeviz.diffLayout", name);
  } else {
    state.layout = LAYOUTS[name] ? name : "relation";
    localStorage.setItem("codeviz.layout", state.layout);
  }
  const tab = activeTab();
  syncLayoutSelect(tab);
  if (tab) {
    relayout(tab);
    renderWorld(tab);
    fitAll(true);
  }
}

/** The active tab's boxes as { name, x, y, w, h } (for --eval checks). */
export function activeBoxes() {
  return (activeTab()?.clusters ?? []).flatMap((c) => c.boxes.map((b) => ({ name: b.sym.name, x: b.x, y: b.y, w: b.w, h: b.h })));
}

/** Selects the first box named `name` and shows its top left at zoom `s` (for --eval). */
export function lookAt(name, s = 1) {
  const tab = activeTab();
  const b = tab && [...tab.boxes.values()].find((x) => x.sym.name === name);
  if (!b) return false;
  tab.selected = b.id;
  renderer.setSelected(b);
  // Exactly zoom s, the box's top left corner near the view's.
  setCam({ x: 40 - b.x * s, y: 40 - b.y * s, s });
  return true;
}

/**
 * Times `steps` frames zooming from fit-all to 1.5x around the focus (for --eval):
 * each frame's paint with the cache warm, and the bitmaps that frame needed.
 */
export function benchZoom(steps = 40) {
  const tab = activeTab();
  if (!tab) return null;
  fitAll(false);
  const from = { ...state.cam };
  const f = tab.boxes.get(tab.clusters[0].focus);
  const to = camFor({ x: f.x, y: f.y, w: f.w, h: f.h }, 1.5);
  const paint = [];
  let bitmapMs = 0;
  let bitmaps = 0;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const s = Math.exp(Math.log(from.s) + (Math.log(to.s) - Math.log(from.s)) * t);
    setCam({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t, s });
    renderer.paint();
    const t0 = performance.now();
    bitmaps += renderer.drain();
    bitmapMs += performance.now() - t0;
    const t1 = performance.now();
    renderer.paint();
    paint.push(performance.now() - t1);
  }
  paint.sort((a, b) => a - b);
  return {
    paintMedianMs: +paint[paint.length >> 1].toFixed(2),
    paintMaxMs: +paint[paint.length - 1].toFixed(2),
    bitmaps,
    bitmapMsEach: +(bitmapMs / Math.max(1, bitmaps)).toFixed(2),
    cacheMB: Math.round(renderer.bytes / 1048576),
  };
}

/** Resolves once the active tab is drawn, every box in view at its proper sharpness. */
export function clusterReady() {
  return renderer.idle();
}

/** The layout choices for this tab: a commit tab's or a symbol tab's. */
function syncLayoutSelect(tab) {
  const list = tab?.diff ? DIFF_LAYOUTS : LAYOUTS;
  const sel = $("cl-layout");
  sel.replaceChildren(...Object.entries(list).map(([k, v]) => el("option", { value: k }, v)));
  sel.value = tab?.diff ? state.diffLayout : state.layout;
}

function layoutKey() {
  return `${state.layout}|${state.diffLayout}`;
}

/**
 * Opens a markdown file, rendered, in a new tab: at `rev`, or on disk when
 * `rev` is "". Its links to other repo files open those the same way.
 */
export async function openDoc(path, rev = "", opts = {}) {
  navigating();
  let r;
  try {
    r = await api(`/api/file?${new URLSearchParams({ path, rev })}`);
  } catch (e) {
    info(e.message);
    if (opts.projector) throw e;
    return;
  }
  const name = path.split("/").pop();
  const t = { id: state.nextTab++, title: rev ? `${name} @ ${rev.slice(0, 9)}` : name, doc: { path, rev, html: renderMarkdown(r.text, path) }, clusters: [], boxes: new Map(), cam: null, layout: layoutKey(), selected: null };
  pushTab(t, opts);
  activate(t.id);
}

const FILE_MAX_LINES = 4000;

/**
 * Opens a source file from disk as one box (projector `file`): lines
 * `line`..`endLine` tinted and framed. A file over FILE_MAX_LINES shows the
 * window around the range. Returns { path, lines, shown }.
 */
export async function openFile(path, line = 0, endLine = 0, opts = {}) {
  navigating();
  const r = await api(`/api/file?${new URLSearchParams({ path, rev: "", links: "1" })}`);
  const all = r.text.replace(/\n$/, "").split("\n");
  const from = line > 0 ? Math.min(line, all.length) : 0;
  const to = from ? Math.min(Math.max(endLine || from, from), all.length) : 0;
  let first = 1;
  if (all.length > FILE_MAX_LINES) first = Math.max(1, Math.min((from || 1) - FILE_MAX_LINES / 2, all.length - FILE_MAX_LINES + 1));
  const lines = all.slice(first - 1, first - 1 + FILE_MAX_LINES).map((l) => l.replace(/\t/g, "    "));
  const b = fileBox(r.path ?? path, lines, first, from, to, r.links ?? {});
  const title = from ? `${b.sym.name}:${from}` : b.sym.name;
  const t = { id: state.nextTab++, title, clusters: [], boxes: new Map(), cam: null, layout: layoutKey(), selected: null };
  const cl = { focus: b.id, title, links: r.links ?? {}, dropped: 0, partial: false, fixed: true, anchor: null, boxes: [b] };
  b.cluster = cl;
  t.boxes.set(b.id, b);
  t.clusters.push(cl);
  place(t, cl);
  // The range at a readable size (zoomed out to fit a long one), else the file's top.
  const y0 = b.y + HEAD_H + BOX_PAD + ((from || first) - first) * LINE_H;
  const h = from ? (to - from + 1) * LINE_H : Math.min(b.h, 40 * LINE_H);
  t.cam = camFor({ x: b.x - 20, y: y0 - 3 * LINE_H, w: Math.min(b.w, 1100) + 40, h: h + 6 * LINE_H }, 1);
  pushTab(t, opts);
  activate(t.id);
  return { path: b.block.file, lines: all.length, shown: [first, first + lines.length - 1] };
}

/** Adds tab `t`; a projector tab replaces the old projector tab in place unless `newTab`. */
function pushTab(t, { projector = false, newTab = false } = {}) {
  if (!projector) {
    state.tabs.push(t);
    return;
  }
  t.projector = true;
  t.title = `▶ ${t.title}`;
  const i = state.tabs.findIndex((o) => o.projector);
  if (i < 0) state.tabs.push(t);
  else if (!newTab) state.tabs[i] = t;
  else {
    const old = state.tabs[i];
    old.projector = false;
    old.title = old.title.replace(/^▶ /, "");
    state.tabs.push(t);
  }
}

/** What the projector reports as the current tab. */
export function activeTabInfo() {
  const t = activeTab();
  return t ? { title: t.title, projector: !!t.projector, tabs: state.tabs.length } : null;
}

/** Opens a commit, range or the working tree ("") in a new commit tab. */
export async function openDiff(rev, opts = {}) {
  navigating();
  info(`reading the changes of ${rev || "the working tree"}…`);
  let d;
  try {
    d = await api(`/api/diff?rev=${encodeURIComponent(rev)}`);
  } catch (e) {
    info(e.message);
    if (opts.projector) throw e;
    return;
  }
  const one = d.commits.length === 1 ? d.commits[0] : null;
  const title = one ? `${one.short} ${one.subject.slice(0, 32)}` : d.head === null ? "working tree" : d.label;
  if (opts.symbol || opts.path) return openSymbolDiff(d, title, opts);
  const boxes = diffBoxes(d);
  const t = { id: state.nextTab++, title: `Δ ${title}`, diff: d.label, clusters: [], boxes: new Map(), cam: null, layout: layoutKey(), selected: null };
  const cl = { focus: boxes[0].id, title: `Δ ${title}`, links: d.links, dropped: d.dropped, partial: false, diff: true, anchor: null, boxes };
  for (const b of boxes) {
    b.cluster = cl;
    t.boxes.set(b.id, b);
  }
  t.clusters.push(cl);
  place(t, cl);
  pushTab(t, opts);
  activate(t.id);
  info(`${d.entries.length} changes in ${d.files.length} files · built in ${(d.ms / 1000).toFixed(1)} s · Home to fit, numpad . for the summary`);
}

/**
 * The projector's diff with `symbol` and/or `path`: only the changed symbols
 * that match (a plain name also matches `ns::name`; `path` is a file or folder
 * prefix), as before | after boxes stacked in a frame named after the commit.
 * Throws, listing the changed symbols, when nothing matches.
 */
function openSymbolDiff(d, title, opts) {
  const q = opts.symbol;
  const named = (e) => !q || e.name === q || e.name.endsWith(`::${q}`);
  const inPath = (e) => !opts.path || e.file === opts.path || e.file.startsWith(opts.path.replace(/\/?$/, "/"));
  const symbols = d.entries.filter((e) => e.type === "symbol");
  const hits = (q ? symbols : d.entries).filter((e) => named(e) && inPath(e));
  if (!hits.length) {
    const names = [...new Set(symbols.filter(inPath).map((e) => e.name))];
    const what = [q && `symbol ${q}`, opts.path && `in ${opts.path}`].filter(Boolean).join(" ");
    const list = names.length ? `; changed symbols${opts.path ? ` in ${opts.path}` : ""}: ${names.slice(0, 30).join(", ")}${names.length > 30 ? `, … (${names.length} in all)` : ""}` : "; it changes no symbols there";
    throw new Error(`no change to ${what} in ${d.label}${list}`);
  }
  // diffBoxes puts the commit card first; only the entry boxes are wanted.
  const boxes = diffBoxes({ ...d, entries: hits, deletedFiles: [], addedFiles: [], fileGroups: [] }).slice(1);
  const label = `Δ ${q ?? opts.path} · ${title}`;
  const t = { id: state.nextTab++, title: `Δ ${q ?? opts.path} @ ${title.split(" ")[0]}`, diff: d.label, framed: true, clusters: [], boxes: new Map(), cam: null, layout: layoutKey(), selected: null };
  const cl = { focus: boxes[0].id, title: label, links: d.links, dropped: 0, partial: false, diff: true, fixed: true, anchor: null, boxes };
  for (const b of boxes) {
    b.cluster = cl;
    t.boxes.set(b.id, b);
  }
  t.clusters.push(cl);
  place(t, cl);
  // All of it when it fits readably, else the frame's width from just above the first changed line.
  const all = camFor(cl.frame, 1);
  if (all.s >= 0.6) t.cam = all;
  else {
    const b = boxes[0];
    const row = Math.max(0, b.rowCache.findIndex((r) => r.bands?.some((x) => x.colour === "addBg" || x.colour === "delBg")));
    const y = b.y + HEAD_H + BOX_PAD + row * LINE_H;
    const top = Math.max(cl.frame.y, y - 8 * LINE_H);
    t.cam = camFor({ x: cl.frame.x, y: top, w: cl.frame.w, h: 40 * LINE_H }, 1);
    // Top-aligned: the width sets the zoom, so centring would leave the top of the view empty.
    t.cam.y = 70 - top * t.cam.s;
  }
  pushTab(t, opts);
  activate(t.id);
  info(`${hits.length} of ${d.entries.length} changes · ${d.label}`);
  return { matched: hits.map((e) => ({ name: e.name, file: e.file, change: e.change })) };
}

/**
 * Opens the cluster of symbol `id`: in a new tab, or with `add` in the active
 * one next to `anchor` (a box id). `cluster` skips the fetch.
 */
export async function openCluster(id, { add = false, anchor = null, cluster = null, projector = false, newTab = false } = {}) {
  if (!add) navigating();
  const tab = activeTab();
  if (add && tab) {
    // A symbol already on screen expands where it is; its new neighbours go around it.
    const here = tab.boxes.get(id);
    info("loading…");
    const c = cluster ?? (await fetchCluster(id));
    if (!c) return;
    if (c.items.every((i) => tab.boxes.has(i.sym.id))) {
      renderWorld(tab);
      if (c.partial) info("nothing new yet: clangd is still loading its index, so callers and callees are missing; try again");
      if (here) glideTo(here, true);
      return;
    }
    appendCluster(tab, c, here ? id : anchor);
    return;
  }
  info("loading…");
  const c = cluster ?? (await fetchCluster(id));
  if (!c) return;
  const focus = c.items.find((i) => i.sym.id === c.focus);
  const t = { id: state.nextTab++, title: focus?.sym.name ?? "?", clusters: [], boxes: new Map(), cam: null, layout: layoutKey(), selected: null };
  pushTab(t, { projector, newTab });
  appendCluster(t, c, null, false);
  activate(t.id);
}

async function fetchCluster(id) {
  try {
    return await api(`/api/cluster?id=${encodeURIComponent(id)}`);
  } catch (e) {
    info(e.message);
    return null;
  }
}

/** Where the cluster view is, for back and forward: the open tab and its camera. */
export function clusterPlace() {
  return { tab: state.active, cam: { ...state.cam } };
}

/** Goes back to a clusterPlace(), if its tab is still open. */
export function restoreClusterPlace(p) {
  if (!state.tabs.some((t) => t.id === p.tab)) return;
  cancelAnimationFrame(state.anim);
  if (state.active !== p.tab) activate(p.tab);
  setCam(p.cam);
}

function activeTab() {
  return state.tabs.find((t) => t.id === state.active);
}

// ---- tabs -----------------------------------------------------------------

function activate(id) {
  const old = activeTab();
  if (old?.doc) old.doc.scroll = $("cl-doc").scrollTop;
  else if (old) old.cam = { ...state.cam };
  state.active = id;
  const tab = activeTab();
  renderTabs();
  syncLayoutSelect(tab);
  // A doc tab shows its page instead of the canvas.
  const doc = $("cl-doc");
  doc.hidden = !tab?.doc;
  document.querySelector(".cl-tools").hidden = !!tab?.doc;
  if (tab?.doc) {
    if (doc.dataset.tab !== String(tab.id)) {
      doc.innerHTML = `<div class="doc-path">${tab.doc.path}${tab.doc.rev ? ` <span>@ ${tab.doc.rev}</span>` : ""}</div>${tab.doc.html}`;
      doc.dataset.tab = String(tab.id);
      doc.scrollTop = tab.doc.scroll ?? 0;
    }
    $("cl-empty").hidden = true;
    info("");
    return;
  }
  if (!tab) {
    renderer.setScene({ boxes: [], groups: [], frames: [] }, new Set());
    renderer.setSelected(null);
    $("cl-empty").hidden = false;
    info("");
    return;
  }
  if (tab.layout !== layoutKey()) relayout(tab);
  renderWorld(tab);
  if (tab.cam) setCam(tab.cam);
  else openView(tab);
}

function closeTab(id) {
  const i = state.tabs.findIndex((t) => t.id === id);
  if (i < 0) return;
  state.tabs.splice(i, 1);
  if (state.active === id) activate(state.tabs[Math.min(i, state.tabs.length - 1)]?.id ?? null);
  else renderTabs();
}

/** Closes these tabs; if the open one goes, `keep` (or a neighbour) opens. */
function closeTabs(ids, keep) {
  const gone = new Set(ids);
  const i = state.tabs.findIndex((t) => t.id === state.active);
  state.tabs = state.tabs.filter((t) => !gone.has(t.id));
  if (!gone.has(state.active)) return renderTabs();
  const next = state.tabs.find((t) => t.id === keep) ?? state.tabs[Math.min(i, state.tabs.length - 1)];
  activate(next?.id ?? null);
}

function onTabsMenu(e) {
  const tabEl = e.target.closest("[data-tab]");
  if (!tabEl) return;
  e.preventDefault();
  const id = Number(tabEl.dataset.tab);
  const i = state.tabs.findIndex((t) => t.id === id);
  const ids = (list) => list.map((t) => t.id);
  showMenu(e.clientX, e.clientY, [
    ["Close", () => closeTab(id)],
    null,
    ["Close tabs to the left", () => closeTabs(ids(state.tabs.slice(0, i)), id), i > 0],
    ["Close tabs to the right", () => closeTabs(ids(state.tabs.slice(i + 1)), id), i < state.tabs.length - 1],
    ["Close other tabs", () => closeTabs(ids(state.tabs.filter((t) => t.id !== id)), id), state.tabs.length > 1],
    ["Close all tabs", () => closeTabs(ids(state.tabs))],
  ]);
}

function renderTabs() {
  $("cl-tabs").replaceChildren(
    ...state.tabs.map((t) =>
      el(
        "div",
        { class: `cl-tab${t.id === state.active ? " on" : ""}${t.projector ? " proj" : ""}`, "data-tab": String(t.id), title: t.clusters.map((c) => c.title).join(" + ") },
        el("span", {}, t.clusters.length > 1 ? `${t.title} +${t.clusters.length - 1}` : t.title),
        el("button", { class: "x", "data-close": String(t.id), title: "Close (middle-click)" }, "×"),
      ),
    ),
  );
}

/**
 * Press a tab to open it; drag it to reorder. The tab follows the pointer and
 * swaps places with a neighbour once the pointer passes that neighbour's middle.
 */
function onTabDrag(e) {
  const tab = e.target.closest("[data-tab]");
  if (!tab || e.button !== 0 || e.target.closest("[data-close]")) return;
  const id = Number(tab.dataset.tab);
  if (state.active !== id) {
    navigating();
    activate(id);
  }
  // activate() re-rendered the tabs; drag the new element.
  const node = $("cl-tabs").querySelector(`[data-tab="${id}"]`);
  let startX = e.clientX;
  let moving = false;
  try {
    node.setPointerCapture(e.pointerId);
  } catch {}
  const move = (ev) => {
    let dx = ev.clientX - startX;
    if (!moving && Math.abs(dx) < 4) return;
    moving = true;
    node.classList.add("dragging");
    const next = node.nextElementSibling;
    const prev = node.previousElementSibling;
    if (dx > 0 && next) {
      const r = next.getBoundingClientRect();
      if (ev.clientX > r.left + r.width / 2) {
        next.after(node);
        startX += r.width;
      }
    } else if (dx < 0 && prev) {
      const r = prev.getBoundingClientRect();
      if (ev.clientX < r.left + r.width / 2) {
        prev.before(node);
        startX -= r.width;
      }
    }
    dx = ev.clientX - startX;
    node.style.transform = `translateX(${dx}px)`;
  };
  const up = () => {
    node.removeEventListener("pointermove", move);
    node.removeEventListener("pointerup", up);
    node.removeEventListener("pointercancel", up);
    if (!moving) return;
    const order = [...$("cl-tabs").children].map((c) => Number(c.dataset.tab));
    state.tabs.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
    renderTabs();
  };
  node.addEventListener("pointermove", move);
  node.addEventListener("pointerup", up);
  node.addEventListener("pointercancel", up);
}

function onTabsClick(e) {
  const x = e.target.closest("[data-close]");
  if (x) return closeTab(Number(x.dataset.close));
  const t = e.target.closest("[data-tab]");
  if (t) activate(Number(t.dataset.tab));
}

// ---- clusters and layout --------------------------------------------------

/** Adds cluster `c` to `tab`: laid out alone, then placed outside the others near `anchor`. */
function appendCluster(tab, c, anchor, glide = true) {
  const focus = c.items.find((i) => i.sym.id === c.focus);
  const items = c.items.filter((i) => !tab.boxes.has(i.sym.id));
  const cl = { focus: c.focus, title: focus?.sym.name ?? "?", links: c.links, dropped: c.dropped, partial: c.partial, anchor, boxes: [] };
  for (const it of items) {
    const b = makeBox(it, cl);
    cl.boxes.push(b);
    tab.boxes.set(b.id, b);
  }
  tab.clusters.push(cl);
  place(tab, cl);
  if (tab.id !== state.active) return;
  renderTabs();
  renderWorld(tab);
  if (glide) glideTo(cl.frame, false);
}

function makeBox(it, cl) {
  const text = it.block?.text ?? it.sym.signature ?? it.sym.name;
  const lines = text.split("\n");
  const m = metrics();
  let cols = 0;
  for (const l of lines) cols = Math.max(cols, l.length);
  const head = it.sym.name.length + (it.block?.file.length ?? 0) + 18;
  cols = Math.min(MAX_COLS, Math.max(cols, head * 0.75, 24));
  return {
    id: it.sym.id,
    sym: it.sym,
    rel: it.rel,
    block: it.block,
    text,
    cluster: cl,
    refs: refsOf(text, cl.links),
    w: Math.ceil(cols * m.charW + BOX_PAD * 2),
    h: Math.ceil(HEAD_H + lines.length * m.lineH + BOX_PAD * 2),
    x: 0,
    y: 0,
  };
}

function refsOf(text, links) {
  const out = new Set();
  for (const w of identifiersIn(text)) if (links[w]) out.add(links[w].id);
  return out;
}

/** Lays out one cluster and puts its frame outside the tab's earlier clusters. */
function place(tab, cl) {
  // A file box or a symbol diff is not laid out: its boxes stack from the origin.
  if (cl.fixed) {
    let y = FRAME_PAD + FRAME_LABEL;
    let w = 0;
    for (const b of cl.boxes) {
      b.x = FRAME_PAD;
      b.y = y;
      y += b.h + FRAME_PAD;
      w = Math.max(w, b.w);
    }
    cl.frame = { label: cl.title, x: 0, y: 0, w: w + FRAME_PAD * 2, h: y };
    cl.groups = [];
    return;
  }
  const l = layout(cl.diff ? state.diffLayout : state.layout, cl.boxes, cl.focus);
  const fw = l.w + FRAME_PAD * 2;
  const fh = l.h + FRAME_PAD * 2 + FRAME_LABEL;
  const others = tab.clusters.filter((o) => o !== cl && o.frame).map((o) => o.frame);
  let target = { x: 0, y: 0 };
  const a = cl.anchor && tab.boxes.get(cl.anchor);
  if (a) target = { x: a.x + a.w / 2, y: a.y + a.h / 2 };
  else if (others.length) target = viewCentre();
  const at = others.length ? placeNear(fw, fh, others, target, FRAME_PAD * 2) : { x: 0, y: 0 };
  cl.frame = { label: cl.title, x: at.x, y: at.y, w: fw, h: fh };
  cl.groups = l.groups.map((g) => ({ ...g, x: g.x + at.x + FRAME_PAD, y: g.y + at.y + FRAME_PAD + FRAME_LABEL }));
  for (const b of cl.boxes) {
    const p = l.pos.get(b.id);
    b.x = at.x + FRAME_PAD + p.x;
    b.y = at.y + FRAME_PAD + FRAME_LABEL + p.y;
  }
}

function relayout(tab) {
  tab.layout = layoutKey();
  for (const c of tab.clusters) c.frame = null;
  for (const c of tab.clusters) place(tab, c);
}

// ---- drawing --------------------------------------------------------------

function renderWorld(tab) {
  const multi = tab.clusters.length > 1;
  renderer.setScene(
    {
      boxes: tab.clusters.flatMap((c) => c.boxes),
      groups: tab.clusters.flatMap((c) => c.groups),
      frames: multi || tab.framed ? tab.clusters.map((c) => c.frame) : [],
    },
    new Set(tab.clusters.map((c) => c.focus)),
  );
  renderer.setSelected(tab.selected ? tab.boxes.get(tab.selected) ?? null : null);
  $("cl-empty").hidden = true;
  const total = tab.clusters.reduce((n, c) => n + c.boxes.length, 0);
  const dropped = tab.clusters.reduce((n, c) => n + c.dropped, 0);
  info(
    `${total} boxes${multi ? ` in ${tab.clusters.length} clusters` : ""}` +
      (dropped ? ` · ${dropped} more left out` : "") +
      (tab.clusters.some((c) => c.partial) ? " · clangd was still loading, some calls may be missing" : "") +
      " · drag to pan, wheel to zoom, Home to fit, numpad . to frame the selection",
  );
}

function info(text) {
  $("cl-info").textContent = text;
}

// ---- clicks ---------------------------------------------------------------

let dragged = false;

/** Events on the floating toolbar or a doc page are their own, not the canvas's. */
function onTools(e) {
  return e.target.closest?.(".cl-tools, .cl-doc");
}

function onClick(e) {
  if (dragged || onTools(e)) return;
  const tab = activeTab();
  if (!tab) return;
  const r = $("cl-viewport").getBoundingClientRect();
  const hit = renderer.hit(e.clientX - r.left, e.clientY - r.top);
  if (hit?.id?.startsWith("doc:")) {
    const [rev, path] = hit.id.slice(4).split("|");
    openDoc(path, rev);
    return;
  }
  if (hit?.id?.startsWith("goto:")) {
    const b = tab.boxes.get(hit.id.slice(5));
    if (b) {
      tab.selected = b.id;
      renderer.setSelected(b);
      glideTo(b, true);
    }
    return;
  }
  if (hit?.id) {
    openCluster(hit.id, { add: e.shiftKey, anchor: hit.box.id });
    return;
  }
  tab.selected = hit?.box.id ?? null;
  renderer.setSelected(hit?.box ?? null);
}

function onHover(e) {
  const r = $("cl-viewport").getBoundingClientRect();
  const hit = renderer.hit(e.clientX - r.left, e.clientY - r.top);
  $("cl-viewport").classList.toggle("on-link", !!hit?.id);
  renderer.setHover(hit?.token ? hit : null);
}

function frameSelected() {
  const tab = activeTab();
  if (!tab) return;
  const b = tab.boxes.get(tab.selected) ?? tab.boxes.get(tab.clusters[0]?.focus);
  if (b) glideTo(b, true);
}

// ---- camera ---------------------------------------------------------------

function initCamera() {
  const vp = $("cl-viewport");
  let drag = null;
  vp.addEventListener("pointerdown", (e) => {
    if ((e.button !== 0 && e.button !== 1) || onTools(e)) return;
    drag = { x: e.clientX, y: e.clientY, cx: state.cam.x, cy: state.cam.y, id: e.pointerId };
    dragged = false;
  });
  vp.addEventListener("pointermove", (e) => {
    if (!drag) return onTools(e) ? undefined : onHover(e);
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (!dragged && Math.hypot(dx, dy) < 4) return;
    if (!dragged) {
      dragged = true;
      vp.setPointerCapture(drag.id);
      vp.classList.add("dragging");
      renderer.setHover(null);
    }
    cancelAnimationFrame(state.anim);
    setCam({ x: drag.cx + dx, y: drag.cy + dy, s: state.cam.s });
  });
  const end = () => {
    drag = null;
    vp.classList.remove("dragging");
    // The click that ends a drag comes after pointerup; let it see `dragged`.
    setTimeout(() => (dragged = false), 0);
  };
  vp.addEventListener("pointerup", end);
  vp.addEventListener("pointercancel", end);
  vp.addEventListener("click", onClick);
  vp.addEventListener(
    "wheel",
    (e) => {
      if (onTools(e)) return;
      e.preventDefault();
      cancelAnimationFrame(state.anim);
      const r = vp.getBoundingClientRect();
      const mx = e.clientX - r.left;
      const my = e.clientY - r.top;
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      const s = clamp(state.cam.s * Math.exp(-dy * 0.0015), MIN_SCALE, MAX_SCALE);
      const k = s / state.cam.s;
      setCam({ x: mx - (mx - state.cam.x) * k, y: my - (my - state.cam.y) * k, s });
    },
    { passive: false },
  );
}

function setCam(c) {
  state.cam = c;
  renderer.setCamera(c);
}

/** The camera that shows world rect `r` in the viewport, at most at `maxScale`. */
function camFor(r, maxScale = 1) {
  const vp = $("cl-viewport").getBoundingClientRect();
  const s = clamp(Math.min((vp.width - 60) / r.w, (vp.height - 60) / r.h, maxScale), MIN_SCALE, MAX_SCALE);
  return { x: vp.width / 2 - (r.x + r.w / 2) * s, y: vp.height / 2 - (r.y + r.h / 2) * s, s };
}

function animateTo(target, ms = 700) {
  cancelAnimationFrame(state.anim);
  const from = { ...state.cam };
  const t0 = performance.now();
  // Zoom in log space and move the world point at the viewport centre, so the motion feels even.
  const ls0 = Math.log(from.s);
  const ls1 = Math.log(target.s);
  const step = (now) => {
    const t = Math.min(1, (now - t0) / ms);
    const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    const s = Math.exp(ls0 + (ls1 - ls0) * e);
    const vp = $("cl-viewport").getBoundingClientRect();
    const cx0 = (vp.width / 2 - from.x) / from.s;
    const cy0 = (vp.height / 2 - from.y) / from.s;
    const cx1 = (vp.width / 2 - target.x) / target.s;
    const cy1 = (vp.height / 2 - target.y) / target.s;
    const cx = cx0 + (cx1 - cx0) * e;
    const cy = cy0 + (cy1 - cy0) * e;
    setCam({ x: vp.width / 2 - cx * s, y: vp.height / 2 - cy * s, s });
    if (t < 1) state.anim = requestAnimationFrame(step);
  };
  state.anim = requestAnimationFrame(step);
}

function glideTo(r, flash) {
  navigating();
  animateTo(camFor({ x: r.x - 30, y: r.y - 30, w: r.w + 60, h: r.h + 60 }, Math.max(state.cam.s, 1)));
  if (flash) renderer.flashBox(r);
}

/** Everything when that is readable, else the focus box at a readable size. */
function openView(tab) {
  fitAll(false);
  if (state.cam.s >= 0.6) return;
  const f = tab.boxes.get(tab.clusters[0].focus);
  if (f) setCam(camFor({ x: f.x - 40, y: f.y - 40, w: f.w + 80, h: f.h + 80 }, 1));
}

function fitAll(animate) {
  const tab = activeTab();
  if (!tab || tab.clusters.length === 0) return;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const c of tab.clusters) {
    x0 = Math.min(x0, c.frame.x);
    y0 = Math.min(y0, c.frame.y);
    x1 = Math.max(x1, c.frame.x + c.frame.w);
    y1 = Math.max(y1, c.frame.y + c.frame.h);
  }
  const cam = camFor({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
  if (animate) animateTo(cam);
  else setCam(cam);
}

function viewCentre() {
  const vp = $("cl-viewport").getBoundingClientRect();
  return { x: (vp.width / 2 - state.cam.x) / state.cam.s, y: (vp.height / 2 - state.cam.y) / state.cam.s };
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

// ---- the symbol box in the toolbar ----------------------------------------

function initFind() {
  const input = $("cl-q");
  const list = $("cl-hits");
  let seq = 0;
  let debounce = 0;
  let hits = [];
  const close = () => (list.hidden = true);
  const pick = (s, add) => {
    close();
    input.value = "";
    openCluster(s.id, { add });
  };
  input.addEventListener("input", () => {
    clearTimeout(debounce);
    debounce = setTimeout(async () => {
      const q = input.value.trim();
      const mine = ++seq;
      if (!q) return close();
      const r = await api(`/api/search?${new URLSearchParams({ q, limit: "14" })}`).catch(() => null);
      if (!r || mine !== seq) return;
      hits = r.results;
      const ql = q.toLowerCase();
      list.replaceChildren(
        ...hits.map((s, i) =>
          el(
            "li",
            { "data-i": String(i) },
            el("span", { class: "cl-chip", style: `--k: var(--k-${s.kind})` }, KIND_SHORT[s.kind] ?? s.kind),
            el("span", { class: "nm" }, highlight(s.name, ql)),
            el("span", { class: "where" }, s.locs[0]?.file ?? ""),
          ),
        ),
      );
      list.hidden = hits.length === 0;
    }, 90);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && hits[0]) pick(hits[0], e.shiftKey);
    if (e.key === "Escape") close();
  });
  input.addEventListener("blur", () => setTimeout(close, 150));
  list.addEventListener("mousedown", (e) => {
    const li = e.target.closest("li[data-i]");
    if (li) pick(hits[Number(li.dataset.i)], e.shiftKey);
  });
}
