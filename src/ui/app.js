// codeviz UI shell: header, status, the sidebar that switches views, and the
// hooks main.ts uses for --shot. Each view lives in views/.

import { $, api } from "./dom.js";
import { initWorkspace, openWorkspaceForm, showWorkspace } from "./views/workspace.js";
import { initSearch, runSearch, showSearch } from "./views/search.js";
import { activeBoxes, activeTabInfo, benchZoom, clusterPlace, clusterReady, initClusters, lookAt, openCluster, openDiff, openDoc, openFile, restoreClusterPlace, setLayout, showClusters } from "./views/clusters.js";
import { initChanges, showChanges } from "./views/changes.js";
import { initSettings, showSettings } from "./views/settings.js";
import { setCacheBudget } from "./render.js";
import { initNav, navigating } from "./nav.js";

const VIEWS = {
  workspace: { el: "view-workspace", show: showWorkspace },
  search: { el: "view-search", show: showSearch },
  clusters: { el: "view-clusters", show: showClusters },
  changes: { el: "view-changes", show: showChanges },
  settings: { el: "view-settings", show: showSettings },
};

const state = { workspace: null, status: null, polled: false, view: "search" };

// What views may ask of the shell.
const shell = {
  workspace: () => state.workspace,
  openCluster: (id, opts) => {
    showView("clusters");
    return openCluster(id, opts);
  },
  openDiff: (rev, opts) => {
    showView("clusters");
    return openDiff(rev, opts);
  },
};

function showView(name) {
  if (state.view !== name) navigating();
  state.view = name;
  for (const [k, v] of Object.entries(VIEWS)) $(v.el).hidden = k !== name;
  for (const b of $("sidebar").querySelectorAll("button")) b.classList.toggle("on", b.dataset.view === name);
  VIEWS[name].show();
}

function toggleSidebar(hidden = !$("sidebar").hidden) {
  $("sidebar").hidden = hidden;
  document.querySelector(".body").classList.toggle("collapsed", hidden);
  $("sidebar-toggle").textContent = hidden ? "›" : "‹";
  $("sidebar-toggle").title = `${hidden ? "Show" : "Hide"} the sidebar (Ctrl+B)`;
  localStorage.setItem("codeviz.sidebar", hidden ? "hidden" : "shown");
}

// ---- status ---------------------------------------------------------------

async function pollState() {
  try {
    const s = await api("/api/state");
    const before = state.status?.phase;
    state.workspace = s.workspace;
    state.status = s.status;
    renderStatus();
    // Symbols arrive while indexing; refresh the open search when the pass ends.
    if (before && before !== "ready" && s.status?.phase === "ready") runSearch();
  } catch {
    $("status-text").textContent = "server unreachable";
  }
}

function renderStatus() {
  const ws = state.workspace;
  $("ws-name").textContent = ws ? `${ws.root}  [${[...ws.roots, ...ws.externals].join(", ")}]` : "no workspace";
  const s = state.status;
  let text = "";
  let pct = 0;
  if (!s) text = "open a workspace";
  else if (s.phase === "starting") text = "Starting clangd…";
  else if (s.phase === "symbols") {
    pct = s.filesTotal ? (100 * s.filesDone) / s.filesTotal : 0;
    text = `Indexing: reading symbols, ${s.filesDone} of ${s.filesTotal} files`;
  } else if (s.phase === "ready") {
    pct = 100;
    text = `${s.symbols.toLocaleString()} symbols indexed`;
  } else if (s.phase === "error") text = `error: ${s.error}`;
  if (s?.clangdIndex?.active) text += ` · clangd background index ${s.clangdIndex.percentage ?? 0}%`;
  $("status-text").textContent = text;
  $("status-bar").style.width = `${pct}%`;
  // The bar is the symbol pass's progress; it goes once the table is ready.
  $("index-status").classList.toggle("busy", !!s && (s.phase !== "ready" || !!s.clangdIndex?.active));
}

// ---- the projector (POST /api/view, through main.ts) ------------------------

/**
 * Runs one projector command in the page: diff, file, symbol or search (see
 * main.ts). Display commands replace the ▶ projector tab unless `newTab`.
 * Returns { ok, ... } or { error }; never throws.
 */
async function project(cmd, a = {}) {
  const opts = { projector: true, newTab: !!a.newTab };
  try {
    if (cmd === "diff") {
      if (a.layout) setLayout(a.layout);
      await shell.openDiff(a.rev, opts);
    } else if (cmd === "file") {
      if (/\.(md|markdown)$/i.test(a.path)) {
        showView("clusters");
        await openDoc(a.path, "", opts);
      } else {
        showView("clusters");
        const r = await openFile(a.path, a.line ?? 0, a.endLine ?? 0, opts);
        await clusterReady();
        return { ok: true, ...r, tab: activeTabInfo() };
      }
    } else if (cmd === "symbol") {
      if (a.layout) setLayout(a.layout);
      const r = await api(`/api/cluster?name=${encodeURIComponent(a.name)}`);
      await shell.openCluster(r.focus, { cluster: r, ...opts });
      const focus = r.items.find((i) => i.sym.id === r.focus)?.sym;
      await clusterReady();
      return { ok: true, symbol: focus ? { name: focus.name, kind: focus.kind } : null, boxes: r.items.length, tab: activeTabInfo() };
    } else if (cmd === "search") {
      showView("search");
      $("q").value = a.query;
      await runSearch();
      return { ok: true, view: "search", results: document.querySelectorAll("#results > *").length };
    } else return { error: `unknown command: ${cmd}` };
    await clusterReady();
    return { ok: true, tab: activeTabInfo() };
  } catch (e) {
    return { error: String(e?.message ?? e) };
  }
}

// ---- hooks for main.ts --shot ---------------------------------------------

window.codeviz = {
  phase: () => (state.status ? state.status.phase : state.workspace === null && state.polled ? "none" : "starting"),
  search: async (q) => {
    showView("search");
    $("q").value = q;
    await runSearch();
  },
  cluster: async (name, layout) => {
    if (layout) setLayout(layout);
    const r = await api(`/api/cluster?name=${encodeURIComponent(name)}`);
    await shell.openCluster(r.focus, { cluster: r });
    await clusterReady();
  },
  diff: async (rev, layout) => {
    if (layout) setLayout(layout);
    await shell.openDiff(rev);
    await clusterReady();
  },
  doc: async (path, rev = "") => {
    showView("clusters");
    await openDoc(path, rev);
  },
  project,
  // Reads the server state now (after the projector switched workspaces).
  refresh: pollState,
  // The view and tab the user sees, for the projector's state command.
  where: () => ({ view: state.view, tab: state.view === "clusters" ? activeTabInfo() : null }),
  ready: clusterReady,
  look: lookAt,
  boxes: activeBoxes,
  benchZoom,
};

// ---- settings -------------------------------------------------------------

/** Applies the settings the page uses: transparency, shell opacity, grid, cache size. */
function applySettings(s) {
  const root = document.documentElement;
  root.classList.toggle("transparent", s.transparent);
  root.classList.toggle("no-grid", !s.grid);
  root.style.setProperty("--shell-alpha", String(s.shellOpacity));
  root.style.setProperty("--canvas-alpha", String(s.canvasOpacity));
  setCacheBudget(s.cacheMB);
}

// ---- start ----------------------------------------------------------------

initWorkspace(shell, async () => {
  $("results").replaceChildren();
  await pollState();
});
initSearch(shell);
initClusters(shell);
initChanges(shell);
initSettings(applySettings);
initNav(
  () => ({ view: state.view, ...clusterPlace() }),
  (p) => {
    showView(p.view);
    restoreClusterPlace(p);
  },
);
$("ws-name").onclick = () => showView("workspace");
$("sidebar-toggle").onclick = () => toggleSidebar();
$("sidebar").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-view]");
  if (b) showView(b.dataset.view);
});
document.addEventListener("keydown", (e) => {
  if (e.ctrlKey && e.key.toLowerCase() === "b") {
    e.preventDefault();
    toggleSidebar();
  }
});
// Files edited while the window was away (an agent's work) are read again.
addEventListener("focus", () => api("/api/rescan", {}).catch(() => {}));
toggleSidebar(localStorage.getItem("codeviz.sidebar") === "hidden");
// Workspace is the landing page; --diff and --cluster switch to Clusters.
showView("workspace");

(async () => {
  api("/api/settings").then((r) => applySettings(r.settings)).catch(() => {});
  await pollState();
  state.polled = true;
  if (state.view === "changes") showChanges();
  // main.ts passes ?root= for a repo with no saved config yet.
  const root = new URLSearchParams(location.search).get("root");
  if (root) openWorkspaceForm(root);
  else if (state.view === "workspace") showWorkspace();
  setInterval(pollState, 500);
})();
