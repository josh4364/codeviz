// Layouts for the cluster view. Each takes boxes ({ id, w, h, sym, rel, block,
// refs }) and returns { pos: Map<id, {x, y}>, groups: [{ label, x, y, w, h }], w, h }
// with the top left corner at 0, 0. Sizes are in world pixels.

import { TYPE_KINDS } from "./dom.js";

export const LAYOUTS = {
  file: "By file",
  folder: "By folder",
  kind: "By kind",
  relation: "By relation",
  affinity: "Affinity",
};

// Layouts for a commit's boxes (diffboxes.js). Summary boxes always come first.
export const DIFF_LAYOUTS = {
  impact: "Biggest changes",
  change: "By change",
  "diff-file": "By file",
  "diff-folder": "By folder",
};

const CHANGE_GROUPS = [
  ["summary", "summary"],
  ["modified", "modified"],
  ["added", "added"],
  ["moved", "moved"],
  ["deleted", "deleted"],
  ["outside", "outside symbols"],
  ["file", "other files"],
];

const GAP = 18;
const PAD = 16;
const LABEL_H = 26;
const GROUP_GAP = 48;

const REL_LABEL = {
  self: "focus",
  returns: "returns it",
  takes: "takes it",
  field: "holds it in a field",
  alias: "typedefs of it",
  type: "types in its signature",
  callee: "calls (callees)",
  caller: "called by (callers)",
};
const REL_ORDER = ["self", "type", "returns", "field", "alias", "callee", "caller", "takes"];

export function layout(name, boxes, focus) {
  switch (name) {
    case "impact":
      return impact(boxes);
    case "change": {
      const label = new Map(CHANGE_GROUPS);
      const rank = new Map(CHANGE_GROUPS.map(([, l], i) => [l, i]));
      return grouped(boxes, (b) => label.get(b.change) ?? b.change, byChurn, packSkyline, (l) => rank.get(l) ?? 99);
    }
    case "diff-file":
      return grouped(boxes, (b) => (b.summary ? "summary" : b.block.file), byFileLine, packColumns, diffRank(boxes, (b) => b.block.file));
    case "diff-folder":
      return grouped(boxes, (b) => (b.summary ? "summary" : dirname(b.block.file)), byFileLine, packColumns, diffRank(boxes, (b) => dirname(b.block.file)));
    case "folder":
      return grouped(boxes, (b) => dirname(b.block?.file ?? "?"), byFileLine, packColumns);
    case "kind":
      return grouped(boxes, kindGroup, byName, packShelf);
    case "relation":
      return relation(boxes);
    case "affinity":
      return affinity(boxes, focus);
    default:
      return grouped(boxes, (b) => b.block?.file ?? "?", byFileLine, packColumns);
  }
}

// ---- grouped layouts ------------------------------------------------------

/**
 * One outlined group per key. Without `rank`, groups are packed in rows,
 * biggest first; with it, in rank order (lowest first), tightly.
 */
function grouped(boxes, keyOf, order, pack, rank) {
  const byKey = new Map();
  for (const b of boxes) {
    const k = keyOf(b);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(b);
  }
  const groups = [...byKey].map(([label, list]) => group(label, pack(list.sort(order))));
  if (rank) {
    groups.sort((a, b) => rank(a.label) - rank(b.label) || a.label.localeCompare(b.label));
    const placed = packSkyline(groups.map((g) => ({ id: g.label, w: g.w, h: g.h })), GROUP_GAP);
    return flatten(groups, placed.pos, placed.w, placed.h);
  }
  groups.sort((a, b) => b.h * b.w - a.h * a.w || a.label.localeCompare(b.label));
  const placed = packShelf(groups.map((g) => ({ id: g.label, w: g.w, h: g.h })), GROUP_GAP);
  return flatten(groups, placed.pos, placed.w, placed.h);
}

/** Summary boxes, then every change biggest first, packed tightly in that order. */
function impact(boxes) {
  const order = [...boxes.filter((b) => b.summary), ...boxes.filter((b) => !b.summary).sort(byChurn)];
  const p = packSkyline(order);
  return { pos: p.pos, groups: [], w: p.w, h: p.h };
}

/** Ranks diff groups: the summary first, then by how much changed in them. */
function diffRank(boxes, keyOf) {
  const churn = new Map();
  for (const b of boxes) if (!b.summary) churn.set(keyOf(b), (churn.get(keyOf(b)) ?? 0) + b.churn);
  return (label) => (label === "summary" ? -Infinity : -(churn.get(label) ?? 0));
}

/** Boxes in a group grouped by relation, the focus in the middle and the rest around it. */
function relation(boxes) {
  const byRel = new Map();
  for (const b of boxes) {
    if (!byRel.has(b.rel)) byRel.set(b.rel, []);
    byRel.get(b.rel).push(b);
  }
  const groups = REL_ORDER.filter((r) => byRel.has(r)).map((r) =>
    group(REL_LABEL[r] ?? r, (r === "self" ? packShelf : packColumns)(byRel.get(r).sort(byFileLine))),
  );
  const rects = [];
  const pos = new Map();
  for (const g of groups) {
    const at = rects.length === 0 ? { x: -g.w / 2, y: -g.h / 2 } : placeNear(g.w, g.h, rects, { x: 0, y: 0 }, GROUP_GAP);
    rects.push({ x: at.x, y: at.y, w: g.w, h: g.h });
    pos.set(g.label, at);
  }
  return normalize(flatten(groups, pos, 0, 0));
}

/** A group: its boxes laid out inside a padded, labelled outline. */
function group(label, inner) {
  return { label, inner, w: inner.w + PAD * 2, h: inner.h + PAD * 2 + LABEL_H };
}

/** Turns groups at `gpos` into one layout. */
function flatten(groups, gpos, w, h) {
  const pos = new Map();
  const out = [];
  for (const g of groups) {
    const at = gpos.get(g.label);
    out.push({ label: g.label, x: at.x, y: at.y, w: g.w, h: g.h });
    for (const [id, p] of g.inner.pos) pos.set(id, { x: at.x + PAD + p.x, y: at.y + PAD + LABEL_H + p.y });
  }
  return { pos, groups: out, w, h };
}

// ---- packing --------------------------------------------------------------

/** Newspaper columns in the given order, so reading order survives. */
function packColumns(boxes, gap = GAP) {
  let area = 0;
  let tallest = 0;
  for (const b of boxes) {
    area += (b.w + gap) * (b.h + gap);
    tallest = Math.max(tallest, b.h);
  }
  const limit = Math.max(tallest, Math.sqrt(area) * 0.8);
  const pos = new Map();
  let x = 0;
  let y = 0;
  let colW = 0;
  let h = 0;
  for (const b of boxes) {
    if (y > 0 && y + b.h > limit) {
      x += colW + gap;
      y = 0;
      colW = 0;
    }
    pos.set(b.id, { x, y });
    y += b.h + gap;
    colW = Math.max(colW, b.w);
    h = Math.max(h, y - gap);
  }
  return { pos, w: x + colW, h };
}

/** Rows of boxes, tallest first, wrapping at a width that keeps the result roughly square. */
function packShelf(boxes, gap = GAP) {
  let area = 0;
  let widest = 0;
  for (const b of boxes) {
    area += (b.w + gap) * (b.h + gap);
    widest = Math.max(widest, b.w);
  }
  const limit = Math.max(widest, Math.sqrt(area) * 1.4);
  const sorted = [...boxes].sort((a, b) => b.h - a.h);
  const pos = new Map();
  let x = 0;
  let y = 0;
  let rowH = 0;
  let w = 0;
  for (const b of sorted) {
    if (x > 0 && x + b.w > limit) {
      x = 0;
      y += rowH + gap;
      rowH = 0;
    }
    pos.set(b.id, { x, y });
    x += b.w + gap;
    rowH = Math.max(rowH, b.h);
    w = Math.max(w, x - gap);
  }
  return { pos, w, h: y + rowH };
}

/**
 * Bottom-left skyline packing in the given order: each box goes where it sits
 * highest, then furthest left, within a width that keeps the result wide.
 */
function packSkyline(boxes, gap = GAP) {
  let area = 0;
  let widest = 0;
  for (const b of boxes) {
    area += (b.w + gap) * (b.h + gap);
    widest = Math.max(widest, b.w + gap);
  }
  const width = Math.max(widest, Math.sqrt(area) * 1.6);
  let sky = [{ x: 0, y: 0, w: width }];
  const pos = new Map();
  let w = 0;
  let h = 0;
  for (const b of boxes) {
    const bw = b.w + gap;
    const bh = b.h + gap;
    let best = null;
    for (let i = 0; i < sky.length; i++) {
      const x = sky[i].x;
      if (x > 0 && x + bw > width + 0.5) break;
      let y = 0;
      let span = 0;
      for (let j = i; j < sky.length && span < bw; j++) {
        y = Math.max(y, sky[j].y);
        span = sky[j].x + sky[j].w - x;
      }
      if (span < bw && x > 0) continue;
      if (!best || y < best.y || (y === best.y && x < best.x)) best = { x, y };
    }
    pos.set(b.id, best);
    const x0 = best.x;
    const x1 = best.x + bw;
    const next = [];
    for (const s of sky) {
      if (s.x + s.w <= x0 || s.x >= x1) next.push(s);
      else {
        if (s.x < x0) next.push({ x: s.x, y: s.y, w: x0 - s.x });
        if (s.x + s.w > x1) next.push({ x: x1, y: s.y, w: s.x + s.w - x1 });
      }
    }
    next.push({ x: x0, y: best.y + bh, w: bw });
    next.sort((a, c) => a.x - c.x);
    sky = [];
    for (const s of next) {
      const last = sky[sky.length - 1];
      if (last && last.y === s.y && Math.abs(last.x + last.w - s.x) < 0.01) last.w += s.w;
      else sky.push({ ...s });
    }
    w = Math.max(w, x1 - gap);
    h = Math.max(h, best.y + bh - gap);
  }
  return { pos, w, h };
}

/**
 * The free spot for a w x h rect, touching one of `rects`, whose centre is
 * nearest `target`. Candidates sit against every side of every rect. Vertical
 * distance counts double, so results spread sideways and fill a wide screen.
 */
export function placeNear(w, h, rects, target, gap = GROUP_GAP) {
  if (rects.length === 0) return { x: target.x - w / 2, y: target.y - h / 2 };
  let best = null;
  let bestD = Infinity;
  const tryAt = (x, y) => {
    const dx = x + w / 2 - target.x;
    const dy = y + h / 2 - target.y;
    const d = dx * dx + 4 * dy * dy;
    if (d >= bestD) return;
    for (const r of rects) {
      if (x < r.x + r.w + gap - 1 && x + w > r.x - gap + 1 && y < r.y + r.h + gap - 1 && y + h > r.y - gap + 1) return;
    }
    best = { x, y };
    bestD = d;
  };
  for (const r of rects) {
    const xs = [r.x, r.x + r.w - w, r.x + r.w / 2 - w / 2, target.x - w / 2];
    const ys = [r.y, r.y + r.h - h, r.y + r.h / 2 - h / 2, target.y - h / 2];
    for (const x of xs) {
      tryAt(x, r.y - h - gap);
      tryAt(x, r.y + r.h + gap);
    }
    for (const y of ys) {
      tryAt(r.x - w - gap, y);
      tryAt(r.x + r.w + gap, y);
    }
  }
  return best;
}

function normalize(l) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const grow = (x, y, w, h) => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + w);
    maxY = Math.max(maxY, y + h);
  };
  for (const g of l.groups) grow(g.x, g.y, g.w, g.h);
  for (const [, p] of l.pos) grow(p.x, p.y, 0, 0);
  if (l.sizes) for (const [id, p] of l.pos) grow(p.x, p.y, l.sizes.get(id).w, l.sizes.get(id).h);
  if (minX === Infinity) return { ...l, w: 0, h: 0 };
  for (const g of l.groups) {
    g.x -= minX;
    g.y -= minY;
  }
  for (const [id, p] of l.pos) l.pos.set(id, { x: p.x - minX, y: p.y - minY });
  return { pos: l.pos, groups: l.groups, w: maxX - minX, h: maxY - minY };
}

// ---- affinity -------------------------------------------------------------

/**
 * A force layout without groups. Boxes that mention each other's symbols are
 * pulled together by springs, everything is pulled gently to the focus, and
 * overlapping boxes push apart. Call chains and shared data paths end up as
 * clumps; loners drift to the rim.
 */
function affinity(boxes, focus) {
  const n = boxes.length;
  const index = new Map(boxes.map((b, i) => [b.id, i]));
  const edges = [];
  boxes.forEach((b, i) => {
    for (const id of b.refs) {
      const j = index.get(id);
      if (j !== undefined && j !== i) edges.push([i, j]);
    }
  });
  const degree = new Float64Array(n);
  for (const [i, j] of edges) {
    degree[i]++;
    degree[j]++;
  }

  // Start on a golden-angle spiral, best connected boxes nearest the middle.
  const order = boxes.map((_, i) => i).sort((a, b) => degree[b] - degree[a]);
  const meanSide = Math.sqrt(boxes.reduce((s, b) => s + b.w * b.h, 0) / Math.max(1, n));
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  order.forEach((i, k) => {
    const r = meanSide * 0.9 * Math.sqrt(k);
    const a = k * 2.39996;
    x[i] = r * Math.cos(a);
    y[i] = r * Math.sin(a);
  });
  const fi = index.get(focus);
  if (fi !== undefined) {
    x[fi] = 0;
    y[fi] = 0;
  }

  const hw = boxes.map((b) => b.w / 2 + GAP / 2);
  const hh = boxes.map((b) => b.h / 2 + GAP / 2);
  const iterations = n > 400 ? 120 : 220;
  for (let it = 0; it < iterations; it++) {
    const cool = 1 - it / iterations;
    for (const [i, j] of edges) {
      const dx = x[j] - x[i];
      const dy = y[j] - y[i];
      const want = (Math.hypot(hw[i], hh[i]) + Math.hypot(hw[j], hh[j])) * 0.7;
      const d = Math.hypot(dx, dy) || 1;
      const f = ((d - want) / d) * 0.04 * cool;
      x[i] += dx * f;
      y[i] += dy * f;
      x[j] -= dx * f;
      y[j] -= dy * f;
    }
    for (let i = 0; i < n; i++) {
      x[i] -= x[i] * 0.004 * cool;
      y[i] -= y[i] * 0.004 * cool;
    }
    pushApart(x, y, hw, hh);
  }
  // Settle: push apart until nothing overlaps, then move any stubborn box to the nearest free spot.
  for (let it = 0; it < 400 && pushApart(x, y, hw, hh); it++);
  resolveOverlaps(boxes, x, y, hw, hh);

  const pos = new Map();
  const sizes = new Map();
  boxes.forEach((b, i) => {
    pos.set(b.id, { x: x[i] - b.w / 2, y: y[i] - b.h / 2 });
    sizes.set(b.id, b);
  });
  return normalize({ pos, groups: [], sizes });
}

/**
 * One pass of pushing overlapping boxes apart along the axis that overlaps
 * least, with sweep and prune on x. Returns whether anything overlapped.
 */
function pushApart(x, y, hw, hh) {
  const n = x.length;
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => x[a] - hw[a] - (x[b] - hw[b]));
  let moved = false;
  for (let a = 0; a < n; a++) {
    const i = order[a];
    for (let c = a + 1; c < n; c++) {
      const j = order[c];
      if (x[j] - hw[j] >= x[i] + hw[i]) break;
      const ox = hw[i] + hw[j] - Math.abs(x[j] - x[i]);
      if (ox <= 0) continue;
      const oy = hh[i] + hh[j] - Math.abs(y[j] - y[i]);
      if (oy <= 0) continue;
      moved = true;
      if (ox < oy) {
        const s = (x[j] >= x[i] ? 1 : -1) * (ox * 0.5 + 0.01);
        x[i] -= s;
        x[j] += s;
      } else {
        const s = (y[j] >= y[i] ? 1 : -1) * (oy * 0.5 + 0.01);
        y[i] -= s;
        y[j] += s;
      }
    }
  }
  return moved;
}

/** Moves every box that still overlaps an earlier one to the free spot nearest where it was. */
function resolveOverlaps(boxes, x, y, hw, hh) {
  const placed = [];
  const order = boxes.map((_, i) => i).sort((a, b) => Math.hypot(x[a], y[a]) - Math.hypot(x[b], y[b]));
  for (const i of order) {
    const r = { x: x[i] - hw[i], y: y[i] - hh[i], w: hw[i] * 2, h: hh[i] * 2 };
    const hits = placed.some((p) => r.x < p.x + p.w && r.x + r.w > p.x && r.y < p.y + p.h && r.y + r.h > p.y);
    if (hits) {
      const at = placeNear(r.w, r.h, placed, { x: x[i], y: y[i] }, 0);
      r.x = at.x;
      r.y = at.y;
      x[i] = r.x + hw[i];
      y[i] = r.y + hh[i];
    }
    placed.push(r);
  }
}

// ---- keys and orders ------------------------------------------------------

function kindGroup(b) {
  if (b.sym.kind === "function" || b.sym.kind === "method") return "functions";
  if (b.sym.kind === "enum") return "enums";
  if (b.sym.kind === "typedef") return "typedefs";
  return TYPE_KINDS.has(b.sym.kind) ? "records" : b.sym.kind;
}

function dirname(file) {
  const at = file.lastIndexOf("/");
  return at < 0 ? "." : file.slice(0, at);
}

function byFileLine(a, b) {
  return (a.block?.file ?? "").localeCompare(b.block?.file ?? "") || (a.block?.start ?? 0) - (b.block?.start ?? 0);
}

function byChurn(a, b) {
  return b.churn - a.churn || byFileLine(a, b);
}

function byName(a, b) {
  return a.sym.name.localeCompare(b.sym.name);
}
