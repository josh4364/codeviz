// Changes view: the working tree and recent commits. Clicking one opens it as
// a commit tab in Clusters. The input takes any rev: a sha, A..B, or A...B
// for a branch against its merge base (a PR). While the view shows, the list
// refreshes when the window gets focus and every REFRESH_MS, so new commits appear.

import { $, api, el } from "../dom.js";

let shell;
const REFRESH_MS = 10_000;

export function initChanges(app) {
  shell = app;
  $("ch-rev").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && $("ch-rev").value.trim()) shell.openDiff($("ch-rev").value.trim());
  });
  $("ch-open").onclick = () => shell.openDiff($("ch-rev").value.trim());
  const refresh = () => !$("view-changes").hidden && document.hasFocus() && loadList();
  addEventListener("focus", refresh);
  setInterval(refresh, REFRESH_MS);
  $("ch-list").addEventListener("click", (e) => {
    const li = e.target.closest("li[data-rev]");
    if (li) shell.openDiff(li.dataset.rev);
  });
}

export async function showChanges() {
  $("ch-rev").focus();
  await loadList();
}

async function loadList() {
  if (!shell.workspace()) {
    $("ch-list").replaceChildren();
    return;
  }
  let r;
  try {
    r = await api("/api/commits?limit=100");
  } catch (e) {
    $("ch-list").replaceChildren(el("li", { class: "ch-error" }, e.message));
    return;
  }
  const rows = [];
  rows.push(el("li", { "data-rev": "", class: r.worktree ? "" : "ch-clean" },
    el("span", { class: "ch-sha" }, "worktree"),
    el("span", { class: "ch-subject" }, r.worktree ? `Uncommitted changes · ${r.worktree} files` : "No uncommitted changes"),
    el("span", { class: "ch-meta" }, "")));
  for (const c of r.commits) {
    rows.push(el("li", { "data-rev": c.sha, title: c.sha },
      el("span", { class: "ch-sha" }, c.short),
      el("span", { class: "ch-subject" }, c.subject),
      el("span", { class: "ch-meta" }, `${c.author} · ${ago(c.date)}`)));
  }
  const top = $("ch-list").scrollTop;
  $("ch-list").replaceChildren(...rows);
  $("ch-list").scrollTop = top;
}

function ago(iso) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 60) return `${Math.round(s / 86400)} d ago`;
  return iso.slice(0, 10);
}
