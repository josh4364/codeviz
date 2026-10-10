// Canvas renderer for the cluster world. Each box is drawn per zoom level
// (levels 2x down to 1/16x, like mip levels) as tiles of TILE device px, cached
// within a memory budget; a frame only draws the cached tiles in view, so the
// cost of a frame barely depends on how much is loaded, and a big box is as
// sharp as a small one. Missing tiles are drawn a few at a time between frames,
// nearest the middle of the view first; until then a tile shows whatever other
// levels have cached for its area.

import { tokenize } from "./code.js";

export const HEAD_H = 24;
export const BOX_PAD = 8;
export const LINE_H = 16;
const FONT_PX = 12;
const MONO = '"JetBrains Mono", "Fira Code", ui-monospace, monospace';
const SANS = "system-ui, sans-serif";
const LEVELS = [0.0625, 0.125, 0.25, 0.5, 1, 2];
// At or under this level, code is drawn as minimap bars instead of glyphs.
const BAR_LEVEL = 0.125;
let BUDGET_BYTES = 384 * 1024 * 1024;

/** The tile cache's memory budget (the cacheMB setting). */
export function setCacheBudget(mb) {
  BUDGET_BYTES = mb * 1024 * 1024;
}
const TILE = 512;
const OVERLAP = 1;
// Under this zoom, names are drawn over the boxes at a readable size.
const NAME_ZOOM = 0.35;
// Boxes smaller than this on screen (device px) are a flat colour.
const SPECK_PX = 4;
const WORK_MS = 10;
const FLASH_MS = 1200;

const COLOURS = {
  "": "#c5c9d1",
  com: "#7f8a7a",
  str: "#d8a26e",
  pp: "#c586c0",
  num: "#b5cea8",
  kw: "#c792ea",
  bt: "#82aaff",
  mac: "#e6c07b",
  type: "#e0b46a",
  fn: "#7cc4a0",
  bg: "#14161a",
  line: "#2c3038",
  headLine: "#2b2f38",
  dim: "#8a909c",
  text: "#d7dae0",
  accent: "#6aa8ff",
  group: "#24272e",
  frame: "#3a3f4b",
  label: "rgba(0, 0, 0, 0.8)",
  // Diffs.
  add: "#7ee2a0",
  del: "#f28b82",
  mod: "#e6c07b",
  move: "#82aaff",
  ln: "#5c6370",
  fold: "#6b7280",
  addBg: "rgba(46, 160, 67, 0.16)",
  delBg: "rgba(248, 81, 73, 0.15)",
  addHi: "rgba(46, 160, 67, 0.42)",
  delHi: "rgba(248, 81, 73, 0.4)",
  foldBg: "rgba(255, 255, 255, 0.04)",
  gutter: "rgba(255, 255, 255, 0.025)",
  head: "#e8eaf0",
};
const KIND_SHORT = { function: "fn", method: "method", struct: "struct", class: "class", union: "union", enum: "enum", typedef: "typedef" };

const font = (px, family = MONO, style = "") => `${style} ${px}px ${family}`.trim();

let measureCtx = null;
function measureText(text, f) {
  measureCtx ??= new OffscreenCanvas(1, 1).getContext("2d");
  measureCtx.font = f;
  return measureCtx.measureText(text).width;
}

/** Width of one monospace cell and the line height, in world px. */
export function metrics() {
  return { charW: measureText("M".repeat(100), font(FONT_PX)) / 100, lineH: LINE_H };
}

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.kinds = readKindColours();
    this.charW = metrics().charW;
    this.scene = { boxes: [], groups: [], frames: [] };
    this.cam = { x: 0, y: 0, s: 1 };
    this.cache = new Map();
    this.bytes = 0;
    this.frame = 0;
    this.queue = [];
    this.selected = null;
    this.focus = new Set();
    this.hover = null;
    this.flash = null;
    this.paintReq = 0;
    this.workReq = 0;
    this.idleWaiters = [];
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
    this.resize();
  }

  resize() {
    const r = this.canvas.parentElement.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.w = r.width;
    this.h = r.height;
    this.canvas.width = Math.max(1, Math.round(r.width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * this.dpr));
    this.canvas.style.width = `${r.width}px`;
    this.canvas.style.height = `${r.height}px`;
    this.draw();
  }

  /** boxes: [{ id, x, y, w, h, sym, rel, block, text, cluster }], groups/frames: [{ label, x, y, w, h }]. */
  setScene(scene, focus) {
    this.scene = scene;
    this.focus = focus;
    this.hover = null;
    this.draw();
  }

  setCamera(cam) {
    this.cam = cam;
    this.draw();
  }

  setSelected(box) {
    this.selected = box;
    this.draw();
  }

  setHover(h) {
    const same = h?.box === this.hover?.box && h?.token === this.hover?.token;
    this.hover = h;
    if (!same) this.draw();
  }

  flashBox(box) {
    this.flash = { box, t0: performance.now() };
    this.draw();
  }

  /** Resolves once every box in view is drawn at its proper level. */
  idle() {
    return new Promise((r) => {
      this.idleWaiters.push(r);
      this.draw();
    });
  }

  draw() {
    if (!this.paintReq) {
      this.paintReq = requestAnimationFrame(() => {
        this.paintReq = 0;
        this.paint();
      });
    }
  }

  // ---- a frame --------------------------------------------------------------

  paint() {
    const { ctx, cam, dpr } = this;
    this.frame++;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    const p = cam.s * dpr;
    ctx.setTransform(p, 0, 0, p, cam.x * dpr, cam.y * dpr);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    const view = { x0: -cam.x / cam.s, y0: -cam.y / cam.s, x1: (this.w - cam.x) / cam.s, y1: (this.h - cam.y) / cam.s };
    const inView = (r) => r.x < view.x1 && r.x + r.w > view.x0 && r.y < view.y1 && r.y + r.h > view.y0;
    const px = 1 / p;

    for (const f of this.scene.frames) {
      if (!inView(f)) continue;
      ctx.setLineDash([8 * Math.max(1, px), 6 * Math.max(1, px)]);
      ctx.lineWidth = Math.max(2, px);
      ctx.strokeStyle = COLOURS.frame;
      roundRect(ctx, f.x, f.y, f.w, f.h, 14);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    for (const g of this.scene.groups) {
      if (!inView(g)) continue;
      ctx.fillStyle = "rgba(255, 255, 255, 0.012)";
      ctx.lineWidth = Math.max(1, px);
      ctx.strokeStyle = COLOURS.group;
      roundRect(ctx, g.x, g.y, g.w, g.h, 8);
      ctx.fill();
      ctx.stroke();
    }

    const level = pickLevel(p);
    const want = [];
    const visible = [];
    for (const b of this.scene.boxes) {
      if (!inView(b)) continue;
      visible.push(b);
      if (b.w * p < SPECK_PX || b.h * p < SPECK_PX) {
        ctx.fillStyle = this.accent(b);
        ctx.globalAlpha = 0.5;
        ctx.fillRect(b.x, b.y, b.w, b.h);
        ctx.globalAlpha = 1;
        continue;
      }
      // The tiles of this box at `level` that overlap the view.
      const tw = TILE / level;
      const i0 = Math.max(0, Math.floor((view.x0 - b.x) / tw));
      const i1 = Math.min(Math.ceil(b.w / tw) - 1, Math.floor((view.x1 - b.x) / tw));
      const j0 = Math.max(0, Math.floor((view.y0 - b.y) / tw));
      const j1 = Math.min(Math.ceil(b.h / tw) - 1, Math.floor((view.y1 - b.y) / tw));
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const t = this.cache.get(key(b, level, i, j));
          if (t) {
            t.used = this.frame;
            ctx.drawImage(t.canvas, b.x + i * tw, b.y + j * tw, t.canvas.width / level, t.canvas.height / level);
          } else {
            want.push({ b, L: level, i, j });
            this.standIn(b, level, i, j);
          }
        }
      }
    }

    // Outlines on top of the bitmaps.
    for (const b of visible) {
      if (this.focus.has(b.id)) this.outline(b, COLOURS.accent, Math.max(2, 2 * px));
    }
    if (this.selected && inView(this.selected)) this.outline(this.selected, "#ffffff", Math.max(2, 2 * px), 3 * px);
    if (this.flash) {
      const t = (performance.now() - this.flash.t0) / FLASH_MS;
      if (t >= 1) this.flash = null;
      else {
        ctx.globalAlpha = 1 - t;
        this.outline(this.flash.box, COLOURS.accent, Math.max(6, 6 * px) * (1 - t), 4 * px);
        ctx.globalAlpha = 1;
        this.draw();
      }
    }
    if (this.hover && cam.s >= NAME_ZOOM) {
      const { box, line, token } = this.hover;
      ctx.fillStyle = COLOURS[token.cls] ?? COLOURS[""];
      ctx.fillRect(box.x + BOX_PAD + token.col * this.charW, box.y + HEAD_H + BOX_PAD + line * LINE_H + 14, token.text.length * this.charW, Math.max(1, px));
    }

    // Far away, names and labels grow to stay readable, capped by their outline's width.
    if (cam.s < NAME_ZOOM) {
      // A commit box names itself in its change colour.
      for (const b of visible) this.name(b, 11 / cam.s, b.change ? this.accent(b) : COLOURS.text, p);
    }
    const far = cam.s < NAME_ZOOM;
    for (const g of this.scene.groups) {
      if (inView(g)) this.label(g.label, g.x + 8, g.y + 4, g.w - 16, far ? 13 / cam.s : 13, far ? COLOURS.text : COLOURS.dim, p, far);
    }
    for (const f of this.scene.frames) {
      if (inView(f)) this.label(f.label, f.x + 12, f.y + 4, f.w - 24, far ? 18 / cam.s : 16, COLOURS.accent, p, far);
    }

    this.queue = want.sort((a, b) => dist(a, view) - dist(b, view));
    if (this.queue.length) this.schedule();
    else this.evict();
    if (!this.queue.length && this.idleWaiters.length) {
      for (const r of this.idleWaiters.splice(0)) r();
    }
  }

  /** The box's colour: its `accent` (a COLOURS name or a colour), else its symbol kind's. */
  accent(b) {
    if (b.accent) return COLOURS[b.accent] ?? b.accent;
    return this.kinds[b.sym.kind] ?? COLOURS.line;
  }

  outline(b, colour, width, grow = 0) {
    const { ctx } = this;
    ctx.strokeStyle = colour;
    ctx.lineWidth = width;
    roundRect(ctx, b.x - grow, b.y - grow, b.w + 2 * grow, b.h + 2 * grow, 4);
    ctx.stroke();
  }

  /**
   * A box's name over it, broken at "_", "::" or a camel step onto up to three
   * lines when that lets it be larger: long names stay readable in narrow boxes.
   */
  name(b, size, colour, p) {
    const text = b.sym.name;
    const maxW = b.w - 6;
    let best = { fs: Math.min(size, maxW / (text.length * 0.62)), lines: [text] };
    for (let n = 2; n <= 3 && best.fs < size; n++) {
      const lines = breakName(text, n);
      const fs = Math.min(size, maxW / (Math.max(...lines.map((l) => l.length)) * 0.62), (b.h - 4) / (lines.length * 1.2));
      if (fs > best.fs * 1.15) best = { fs, lines };
    }
    if (best.lines.length === 1) return this.label(text, b.x + 3, b.y + 2, maxW, size, colour, p);
    best.lines.forEach((l, i) => this.label(l, b.x + 3, b.y + 2 + i * best.fs * 1.2, maxW, best.fs, colour, p));
  }

  /** A one-line label at (x, y) no wider than `maxW`, `size` world px tall at most. */
  label(text, x, y, maxW, size, colour, p, backed = true) {
    const { ctx } = this;
    const fit = maxW / (text.length * 0.62);
    const fs = Math.min(size, fit);
    if (fs * p < 5) return;
    ctx.font = font(fs);
    ctx.textBaseline = "top";
    if (backed) {
      ctx.fillStyle = COLOURS.label;
      ctx.fillRect(x - 2, y - 1, Math.min(maxW, text.length * fs * 0.62) + 4, fs * 1.2);
    }
    ctx.fillStyle = colour;
    ctx.fillText(text, x, y, maxW);
  }

  // ---- bitmaps ----------------------------------------------------------------

  /**
   * Fills the area of the missing tile (b, L, i, j) from other levels' cached
   * tiles: the nearest coarser levels first, then sharper ones, stopping at the
   * first level that covers it; a blank box if none has anything.
   */
  standIn(b, L, i, j) {
    const { ctx } = this;
    const tw = TILE / L;
    const x0 = i * tw;
    const y0 = j * tw;
    const x1 = Math.min(b.w, x0 + tw);
    const y1 = Math.min(b.h, y0 + tw);
    ctx.fillStyle = COLOURS.bg;
    ctx.fillRect(b.x + x0, b.y + y0, x1 - x0, y1 - y0);
    if (y0 === 0) {
      ctx.save();
      ctx.translate(b.x + x0, b.y);
      headBar(ctx, this.accent(b), x1 - x0);
      ctx.restore();
    }
    const order = LEVELS.filter((l) => l < L).reverse().concat(LEVELS.filter((l) => l > L));
    ctx.save();
    ctx.beginPath();
    ctx.rect(b.x + x0, b.y + y0, x1 - x0, y1 - y0);
    ctx.clip();
    for (const l of order) {
      const lw = TILE / l;
      let all = true;
      for (let jj = Math.floor(y0 / lw); jj * lw < y1; jj++) {
        for (let ii = Math.floor(x0 / lw); ii * lw < x1; ii++) {
          const t = this.cache.get(key(b, l, ii, jj));
          if (!t) {
            all = false;
            continue;
          }
          t.used = this.frame;
          ctx.drawImage(t.canvas, b.x + ii * lw, b.y + jj * lw, t.canvas.width / l, t.canvas.height / l);
        }
      }
      if (all) break;
    }
    ctx.restore();
  }

  schedule() {
    if (this.workReq) return;
    this.workReq = requestAnimationFrame(() => {
      this.workReq = 0;
      const t0 = performance.now();
      let drew = false;
      while (this.queue.length && performance.now() - t0 < WORK_MS) {
        const q = this.queue.shift();
        const k = key(q.b, q.L, q.i, q.j);
        if (this.cache.has(k)) continue;
        this.cache.set(k, this.drawTile(q));
        drew = true;
      }
      if (drew) this.draw();
      if (this.queue.length) this.schedule();
    });
  }

  /** Drops the least recently drawn bitmaps until the cache fits its budget. */
  evict() {
    if (this.bytes <= BUDGET_BYTES) return;
    const entries = [...this.cache].sort((a, b) => a[1].used - b[1].used);
    for (const [k, bm] of entries) {
      if (this.bytes <= BUDGET_BYTES * 0.8 || bm.used === this.frame) break;
      this.cache.delete(k);
      this.bytes -= bm.bytes;
    }
  }

  /**
   * Tile (i, j) of box `b` at level L: TILE device px square, less at the box's
   * right and bottom edges. Inner tiles reach OVERLAP px into the next one, so
   * no seam shows where they meet at fractional screen positions.
   */
  drawTile({ b, L, i, j }) {
    const tw = TILE / L;
    const w = Math.max(1, Math.min(TILE + OVERLAP, Math.ceil((b.w - i * tw) * L)));
    const h = Math.max(1, Math.min(TILE + OVERLAP, Math.ceil((b.h - j * tw) * L)));
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext("2d");
    ctx.scale(L, L);
    ctx.translate(-i * tw, -j * tw);
    // Only the rows that reach into this tile.
    this.paintBox(ctx, b, L, j * tw, j * tw + h / L);
    const bytes = w * h * 4;
    this.bytes += bytes;
    return { canvas, bytes, used: this.frame };
  }

  /** Draws box `b` at box-local origin, rows between box y `y0` and `y1` only. */
  paintBox(ctx, b, L, y0, y1) {
    const kind = this.accent(b);

    ctx.fillStyle = COLOURS.bg;
    ctx.fillRect(0, 0, b.w, b.h);

    // Header: a bar in the box's colour with the kind in italics, the name,
    // tags, and the right-hand text if it fits.
    headBar(ctx, kind, b.w);
    ctx.strokeStyle = COLOURS.line;
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, b.w - 1, b.h - 1);
    ctx.textBaseline = "middle";
    const head = headLayout(b);
    ctx.font = font(11, MONO, "italic");
    ctx.fillStyle = head.chipColour ?? kind;
    ctx.fillText(head.chip, head.chipX, 12.5);
    ctx.font = font(FONT_PX, MONO, "600");
    ctx.fillStyle = COLOURS.text;
    ctx.fillText(head.name, head.nameX0, 12);
    let x = head.nameX1 + 8;
    for (const t of head.tags) {
      ctx.font = t.italic ? font(12, SANS, "italic") : font(11, t.fill ? SANS : MONO, t.fill ? "600" : "");
      const tw = measureText(t.text, ctx.font);
      if (t.fill) {
        ctx.fillStyle = COLOURS[t.colour] ?? t.colour;
        ctx.fillRect(x, 5, tw + 10, 15);
        ctx.fillStyle = "#0d1117";
        ctx.fillText(t.text, x + 5, 12.5);
        x += tw + 18;
      } else {
        ctx.fillStyle = COLOURS[t.colour] ?? t.colour ?? COLOURS.dim;
        ctx.fillText(t.text, x, 12);
        x += tw + 10;
      }
    }
    if (head.right) {
      ctx.font = font(11);
      const ww = measureText(head.right, ctx.font);
      if (x + ww < b.w - 8) {
        ctx.fillStyle = COLOURS.dim;
        ctx.fillText(head.right, b.w - 8 - ww, 12);
      }
    }

    // Body: rows of bands and tokens on the monospace grid.
    ctx.save();
    ctx.beginPath();
    ctx.rect(3, HEAD_H, b.w - 4, b.h - HEAD_H - 1);
    ctx.clip();
    const rows = rowsOf(b);
    const cw = this.charW;
    const top = HEAD_H + BOX_PAD;
    const r0 = Math.max(0, Math.floor((y0 - top) / LINE_H));
    const r1 = Math.min(rows.length, Math.ceil((y1 - top) / LINE_H) + 1);
    for (let i = r0; i < r1; i++) {
      for (const band of rows[i].bands ?? []) {
        ctx.fillStyle = COLOURS[band.colour] ?? band.colour;
        const x0 = band.col < 0 ? 3 : BOX_PAD + band.col * cw;
        const w = band.cols === Infinity ? b.w - x0 : band.cols * cw;
        ctx.fillRect(x0, top + i * LINE_H, w, LINE_H);
      }
    }
    if (L <= BAR_LEVEL) {
      ctx.globalAlpha = 0.75;
      for (let i = r0; i < r1; i++) {
        for (const t of rows[i].tokens) {
          if (!t.text.trim()) continue;
          const lead = t.text.length - t.text.trimStart().length;
          ctx.fillStyle = COLOURS[t.cls] ?? COLOURS[""];
          ctx.fillRect(BOX_PAD + (t.col + lead) * cw, top + i * LINE_H + 3, t.text.trim().length * cw, 10);
        }
      }
      ctx.globalAlpha = 1;
    } else {
      ctx.textBaseline = "alphabetic";
      for (let i = r0; i < r1; i++) {
        const y = top + i * LINE_H + 12;
        for (const t of rows[i].tokens) {
          ctx.font = t.bold ? font(FONT_PX, MONO, "600") : t.italic ? font(FONT_PX, MONO, "italic") : font(FONT_PX);
          ctx.fillStyle = COLOURS[t.cls] ?? t.cls ?? COLOURS[""];
          ctx.fillText(t.text, BOX_PAD + t.col * cw, y);
        }
      }
    }
    ctx.restore();
  }

  /** Draws every queued bitmap now; returns how many. */
  drain() {
    let n = 0;
    for (const q of this.queue.splice(0)) {
      const k = key(q.b, q.L, q.i, q.j);
      if (this.cache.has(k)) continue;
      this.cache.set(k, this.drawTile(q));
      n++;
    }
    return n;
  }

  // ---- hit testing ------------------------------------------------------------

  /** What is at viewport point (sx, sy): { box, token?, line?, id? } or null. */
  hit(sx, sy) {
    const wx = (sx - this.cam.x) / this.cam.s;
    const wy = (sy - this.cam.y) / this.cam.s;
    const boxes = this.scene.boxes;
    for (let i = boxes.length - 1; i >= 0; i--) {
      const b = boxes[i];
      if (wx < b.x || wx > b.x + b.w || wy < b.y || wy > b.y + b.h) continue;
      const lx = wx - b.x;
      const ly = wy - b.y;
      if (ly < HEAD_H) {
        const head = headLayout(b);
        if (head.nameId && lx >= head.nameX0 && lx <= head.nameX1) return { box: b, id: head.nameId, head: true };
        return { box: b };
      }
      const line = Math.floor((ly - HEAD_H - BOX_PAD) / LINE_H);
      const col = (lx - BOX_PAD) / this.charW;
      const token = rowsOf(b)[line]?.tokens.find((t) => col >= t.col && col < t.col + t.text.length);
      if (token?.id) return { box: b, line, token, id: token.id };
      return { box: b };
    }
    return null;
  }
}

/** Where the header's chip and name sit, in box px. */
/**
 * Where the header's parts sit, in box px. A box's `header` is { chip,
 * chipColour?, name, nameId? (clicking the name opens it), tags: [{ text,
 * colour?, fill?, italic? }], right? }; without one, a code box's is made
 * from its symbol, relation and block.
 */
function headLayout(b) {
  if (b.headLayout) return b.headLayout;
  const h = b.header ?? {
    name: b.sym.name,
    nameId: b.id,
    tags: b.rel && b.rel !== "self" ? [{ text: b.rel, italic: true }] : [],
    right: b.block ? `${b.block.file}:${b.block.start}` : "",
  };
  const chip = h.chip ?? KIND_SHORT[b.sym.kind] ?? b.sym.kind;
  const chipX = 10;
  const chipW = measureText(chip, font(11, MONO, "italic"));
  const nameX0 = chipX + chipW + 8;
  const nameX1 = nameX0 + measureText(h.name, font(FONT_PX, MONO, "600"));
  b.headLayout = { ...h, tags: h.tags ?? [], chip, chipX, chipW, nameX0, nameX1 };
  return b.headLayout;
}

/**
 * A box's body: rows of { tokens: [{ col, text, cls, id?, bold?, italic? }],
 * bands?: [{ col, cols, colour }] }, from `b.body()` or else its code text.
 */
function rowsOf(b) {
  b.rowCache ??= b.body ? b.body() : tokenize(b.text, b.cluster.links, b.id).map((tokens) => ({ tokens }));
  return b.rowCache;
}

/** The smallest level at least as sharp as `p` device px per world px. */
function pickLevel(p) {
  for (const l of LEVELS) if (l >= p) return l;
  return LEVELS[LEVELS.length - 1];
}

// Each box object gets its own cache id: ids repeat across tabs (every commit
// tab has a "diff:card"; one symbol can be in several clusters) with different content.
let nextCacheId = 0;
const cacheIds = new WeakMap();

function key(b, L, i, j) {
  let id = cacheIds.get(b);
  if (id === undefined) cacheIds.set(b, (id = nextCacheId++));
  return `${id}|${L}|${i},${j}`;
}

/** How far tile q's middle is from the view's. */
function dist(q, v) {
  const tw = TILE / q.L;
  const x = q.b.x + Math.min(q.b.w, (q.i + 0.5) * tw);
  const y = q.b.y + Math.min(q.b.h, (q.j + 0.5) * tw);
  return Math.hypot(x - (v.x0 + v.x1) / 2, y - (v.y0 + v.y1) / 2);
}

/** `text` in about `n` lines of even length, broken only where a word starts. */
function breakName(text, n) {
  const cuts = [];
  for (let i = 1; i < text.length; i++) {
    const a = text[i - 1];
    const c = text[i];
    if ((a === "_" && c !== "_") || (a === ":" && c !== ":") || (/[a-z0-9]/.test(a) && /[A-Z]/.test(c))) cuts.push(i);
  }
  const lines = [];
  let from = 0;
  for (let k = 1; k < n; k++) {
    const target = (text.length * k) / n;
    let at = -1;
    for (const c of cuts) if (c > from && (at < 0 || Math.abs(c - target) < Math.abs(at - target))) at = c;
    if (at < 0) break;
    lines.push(text.slice(from, at));
    from = at;
  }
  lines.push(text.slice(from));
  return lines;
}

/** Sharp corners everywhere; `r` is ignored. */
function roundRect(ctx, x, y, w, h) {
  ctx.beginPath();
  ctx.rect(x, y, w, h);
}

/** A box's header background: its colour, darkened, with a bright top edge. */
function headBar(ctx, colour, w) {
  ctx.fillStyle = COLOURS.bg;
  ctx.fillRect(0, 0, w, HEAD_H);
  ctx.globalAlpha = 0.3;
  ctx.fillStyle = colour;
  ctx.fillRect(0, 0, w, HEAD_H);
  ctx.globalAlpha = 1;
  ctx.fillRect(0, 0, w, 2);
}

function readKindColours() {
  const css = getComputedStyle(document.documentElement);
  const out = {};
  for (const k of Object.keys(KIND_SHORT)) out[k] = css.getPropertyValue(`--k-${k}`).trim() || COLOURS.line;
  return out;
}
