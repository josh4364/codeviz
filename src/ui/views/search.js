// Symbol search view: a search box over the server's symbol table. Clicking a
// result opens its cluster in a new tab; shift-click adds it to the open tab.

import { $, api, el, highlight, KINDS } from "../dom.js";

const state = { kinds: new Set(KINDS), seq: 0 };
let shell;

export function initSearch(app) {
  shell = app;
  renderKinds();
  let debounce = 0;
  $("q").addEventListener("input", () => {
    clearTimeout(debounce);
    debounce = setTimeout(runSearch, 100);
  });
  $("results").addEventListener("click", (e) => {
    const li = e.target.closest("li[data-id]");
    if (li) shell.openCluster(li.dataset.id, { add: e.shiftKey });
  });
}

export function showSearch() {
  $("q").focus();
}

function renderKinds() {
  const box = $("kinds");
  box.replaceChildren();
  for (const k of KINDS) {
    const b = el("button", { class: state.kinds.has(k) ? "on" : "", style: `background: var(--k-${k}); color: #0d1117` }, k);
    b.onclick = (ev) => {
      // Shift-click shows only this kind.
      if (ev.shiftKey) state.kinds = new Set([k]);
      else if (state.kinds.has(k)) state.kinds.delete(k);
      else state.kinds.add(k);
      renderKinds();
      runSearch();
    };
    box.append(b);
  }
}

export async function runSearch() {
  const q = $("q").value;
  const seq = ++state.seq;
  if (!q.trim() || !shell.workspace()) {
    $("results").replaceChildren();
    $("summary").textContent = "";
    return;
  }
  const params = new URLSearchParams({ q, limit: "500" });
  if (state.kinds.size !== KINDS.length) params.set("kinds", [...state.kinds].join(","));
  let r;
  try {
    r = await api(`/api/search?${params}`);
  } catch (e) {
    $("summary").textContent = String(e.message);
    return;
  }
  if (seq !== state.seq) return;
  const ql = q.trim().toLowerCase();
  const qualified = ql.includes("::");
  $("results").replaceChildren(...r.results.map((s) => renderSym(s, ql, qualified)));
  const shown = r.results.length < r.total ? ` (showing ${r.results.length})` : "";
  $("summary").textContent = `${r.total.toLocaleString()} matches${shown} · ${r.ms} ms · click opens a cluster, shift-click adds to it`;
}

function renderSym(s, q, qualified) {
  const def = s.locs.find((l) => l.def) || s.locs[0];
  const others = s.locs.length - 1;
  const name = el("div", { class: "name", title: s.id });
  if (s.container) {
    name.append(el("span", { class: "scope" }, qualified ? highlight(`${s.container}::`, q) : `${s.container}::`));
  }
  name.append(highlight(s.name, q));
  const loc = def ? `${def.file}:${def.line}` : "";
  return el(
    "li",
    { "data-id": s.id },
    el("span", { class: "kind", style: `background: var(--k-${s.kind})` }, s.kind),
    name,
    el("span", { class: "root" }, s.root),
    el(
      "div",
      { class: "detail" },
      el("span", { class: "sig" }, s.signature),
      el("span", { class: "loc", title: s.locs.map((l) => `${l.def ? "def " : "decl"} ${l.file}:${l.line}`).join("\n") },
        loc + (others > 0 ? `  +${others}` : "")),
    ),
  );
}
