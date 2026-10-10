// Small helpers shared by every view.

export const $ = (id) => document.getElementById(id);

export const KINDS = ["function", "method", "struct", "class", "union", "enum", "typedef"];
export const TYPE_KINDS = new Set(["struct", "class", "union", "enum", "typedef"]);

export async function api(path, body) {
  const r = await fetch(path, body === undefined ? {} : {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await r.json();
  if (!r.ok) throw new Error(json.error || r.statusText);
  return json;
}

/**
 * A context menu at (x, y). Items are [label, action, enabled = true], or null
 * for a separator. Any click elsewhere, Escape, or a blur closes it.
 */
export function showMenu(x, y, items) {
  document.querySelector(".menu")?.remove();
  const menu = el("div", { class: "menu" });
  for (const it of items) {
    if (!it) {
      menu.append(el("div", { class: "sep" }));
      continue;
    }
    const [label, action, enabled = true] = it;
    const b = el("button", enabled ? {} : { disabled: "" }, label);
    b.onclick = () => {
      close();
      action();
    };
    menu.append(b);
  }
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, innerWidth - r.width - 4)}px`;
  menu.style.top = `${Math.min(y, innerHeight - r.height - 4)}px`;
  const away = (e) => {
    if (!menu.contains(e.target)) close();
  };
  const key = (e) => e.key === "Escape" && close();
  function close() {
    menu.remove();
    removeEventListener("pointerdown", away, true);
    removeEventListener("keydown", key, true);
    removeEventListener("blur", close);
  }
  addEventListener("pointerdown", away, true);
  addEventListener("keydown", key, true);
  addEventListener("blur", close);
}

export function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k === "style") e.style.cssText = v;
    else e.setAttribute(k, v);
  }
  for (const c of children) if (c != null) e.append(c);
  return e;
}

/** `text` with the parts that match the search query `q` (lowercase) marked. */
export function highlight(text, q) {
  const frag = document.createDocumentFragment();
  const lower = text.toLowerCase();
  let from = 0;
  if (q && lower.includes(q)) {
    for (let at = lower.indexOf(q); at >= 0; at = lower.indexOf(q, at + q.length)) {
      frag.append(text.slice(from, at), el("mark", {}, text.slice(at, at + q.length)));
      from = at + q.length;
    }
  } else if (q) {
    // The server also matches with every `_` ignored; mark that span.
    const span = looseSpan(lower, q.replaceAll("_", ""));
    if (span) {
      frag.append(text.slice(0, span[0]), el("mark", {}, text.slice(span[0], span[1])));
      from = span[1];
    }
  }
  frag.append(text.slice(from));
  return frag;
}

/** Where `loose` (no `_`) matches `lower` when `_` is skipped: [start, end) in `lower`. */
function looseSpan(lower, loose) {
  if (!loose) return null;
  const idx = [];
  let stripped = "";
  for (let i = 0; i < lower.length; i++) {
    if (lower[i] !== "_") {
      idx.push(i);
      stripped += lower[i];
    }
  }
  const at = stripped.indexOf(loose);
  return at < 0 ? null : [idx[at], idx[at + loose.length - 1] + 1];
}
