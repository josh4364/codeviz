// Workspace view, the landing page: the open repo's index status, and the form
// to pick a repo, its compile database, the folders to index and the include
// folders outside the repo (SDL from the Nix store) whose headers to index too.

import { $, api, el } from "../dom.js";

let shell;
// The folder tree: [{ path, count, children: [{ path, count }], open }] and the ticked paths.
let tree = [];
const ticked = new Set();
// Include folders outside the repo: [{ key, label, dir, headers, users }], and the ticked keys.
let externals = [];
const tickedExternals = new Set();
let onOpened = async () => {};

export function initWorkspace(app, opened) {
  shell = app;
  onOpened = opened;
  $("setup-inspect").onclick = () => inspect();
  $("setup-root").addEventListener("keydown", (e) => e.key === "Enter" && inspect());
  $("setup-cdb").onchange = () => inspect($("setup-cdb").value);
  $("setup-browse").onclick = async () => {
    try {
      const r = await api("/api/pick-folder", {});
      if (r.path) {
        $("setup-root").value = r.path;
        await inspect();
      }
    } catch (e) {
      $("setup-error").textContent = e.message;
    }
  };
  $("setup-open").onclick = async () => {
    try {
      await api("/api/workspace/open", { root: $("setup-root").value, compileDb: $("setup-cdb").value, roots: chosenRoots(), externals: [...tickedExternals] });
      await onOpened();
    } catch (e) {
      $("setup-error").textContent = e.message;
    }
  };
}

/** Shows the open workspace's settings, unless the form already holds a repo. */
export async function showWorkspace() {
  if ($("setup-root").value) return;
  const root = shell.workspace()?.root;
  if (root) await openWorkspaceForm(root);
}

/** Fills the form for `root` and reads its compile databases and folders. */
export async function openWorkspaceForm(root) {
  $("setup-error").textContent = "";
  $("setup-root").value = root;
  if (root) await inspect();
}

async function inspect(compileDb) {
  $("setup-error").textContent = "";
  let r;
  try {
    r = await api("/api/workspace/inspect", { root: $("setup-root").value, compileDb });
  } catch (e) {
    $("setup-error").textContent = e.message;
    return;
  }
  $("setup-root").value = r.root;
  const sel = $("setup-cdb");
  sel.replaceChildren(...r.compileDbs.map((p) => el("option", { value: p }, p.slice(r.root.length + 1))));
  if (r.compileDb) sel.value = r.compileDb;
  if (!r.compileDbs.length) $("setup-error").textContent = "no compile_commands.json found";
  tree = r.folders.filter((f) => !f.path.includes("/")).map((f) => ({ ...f, children: r.folders.filter((c) => c.path.startsWith(f.path + "/")) }));
  ticked.clear();
  for (const p of r.roots) {
    ticked.add(p);
    for (const c of tree.find((t) => t.path === p)?.children ?? []) ticked.add(c.path);
  }
  // Open the folders that have something ticked.
  for (const t of tree) t.open = t.children.some((c) => ticked.has(c.path)) && !ticked.has(t.path);
  externals = r.externals;
  tickedExternals.clear();
  for (const k of r.chosenExternals) tickedExternals.add(k);
  renderTree();
}

/**
 * What to index: a top folder when it is ticked (all of it), else its ticked
 * subfolders.
 */
function chosenRoots() {
  const out = [];
  for (const t of tree) {
    if (ticked.has(t.path)) out.push(t.path);
    else for (const c of t.children) if (ticked.has(c.path)) out.push(c.path);
  }
  return out;
}

function renderTree() {
  const max = Math.max(1, ...tree.map((t) => t.count));
  const row = (f, depth, extra = {}) => {
    const box = el("input", { type: "checkbox" });
    box.checked = ticked.has(f.path);
    box.indeterminate = !!extra.some;
    box.onchange = () => toggle(f, box.checked);
    const caret = extra.caret === undefined ? el("span", { class: "caret" }) : el("button", { class: "caret", title: extra.open ? "Collapse" : "Expand" }, extra.caret);
    if (extra.toggleOpen) caret.onclick = extra.toggleOpen;
    return el(
      "li",
      { class: depth ? "sub" : "" },
      caret,
      el("label", {}, box, el("span", { class: "name" }, depth ? f.path.slice(f.path.indexOf("/") + 1) : f.path)),
      el("span", { class: "count" }, String(f.count)),
      el("span", { class: "weight" }, el("span", { style: `width: ${(100 * f.count) / max}%` })),
    );
  };
  const rows = [];
  for (const t of tree) {
    const some = !ticked.has(t.path) && t.children.some((c) => ticked.has(c.path));
    rows.push(row(t, 0, {
      some,
      open: t.open,
      caret: t.children.length ? (t.open ? "▾" : "▸") : undefined,
      toggleOpen: () => {
        t.open = !t.open;
        renderTree();
      },
    }));
    if (t.open) for (const c of t.children) rows.push(row(c, 1));
  }
  $("setup-folders").replaceChildren(...rows);
  renderExternals();
  const roots = chosenRoots();
  const files = roots.reduce((n, p) => n + (tree.find((t) => t.path === p) ?? tree.flatMap((t) => t.children).find((c) => c.path === p)).count, 0);
  const headers = externals.reduce((n, x) => n + (tickedExternals.has(x.key) ? x.headers : 0), 0);
  $("setup-total").textContent = roots.length
    ? `${files.toLocaleString()} files${headers ? ` and ${headers.toLocaleString()} external headers` : ""} selected`
    : "nothing selected";
}

/** One row per external include folder: its headers, weighted against the biggest. */
function renderExternals() {
  const max = Math.max(1, ...externals.map((x) => x.headers));
  const rows = externals.map((x) => {
    const box = el("input", { type: "checkbox" });
    box.checked = tickedExternals.has(x.key);
    box.onchange = () => {
      box.checked ? tickedExternals.add(x.key) : tickedExternals.delete(x.key);
      renderTree();
    };
    return el(
      "li",
      { title: `${x.dir}\nincluded by ${x.users} files` },
      el("span", { class: "caret" }),
      el("label", {}, box, el("span", { class: "name" }, x.label)),
      el("span", { class: "count" }, String(x.headers)),
      el("span", { class: "weight" }, el("span", { style: `width: ${(100 * x.headers) / max}%` })),
    );
  });
  $("setup-externals").replaceChildren(...rows);
  $("setup-externals").hidden = !rows.length;
}

/** Ticking a top folder ticks all of it; a subfolder's tick updates its parent. */
function toggle(f, on) {
  const top = tree.find((t) => t.path === f.path);
  if (top) {
    for (const p of [top.path, ...top.children.map((c) => c.path)]) on ? ticked.add(p) : ticked.delete(p);
  } else {
    const parent = tree.find((t) => f.path.startsWith(t.path + "/"));
    on ? ticked.add(f.path) : ticked.delete(f.path);
    if (parent) {
      const all = parent.children.every((c) => ticked.has(c.path));
      all ? ticked.add(parent.path) : ticked.delete(parent.path);
    }
  }
  renderTree();
}
