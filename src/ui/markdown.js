// Markdown to HTML with marked (vendor/marked.min.js, from hexcode), made
// safe: raw HTML stays text, links and images keep only web URLs. Links to
// other files in the repo become doc links (relative to `base`, the
// markdown file's folder), and C/C++ fences get code.js's colours.

import { tokenize } from "./code.js";

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);
const WEB = /^(https?:|mailto:)/i;
const C_LANGS = new Set(["c", "h", "cpp", "c++", "cc", "hpp", "cxx"]);

let base = "";

marked.use({
  gfm: true,
  renderer: {
    html({ text }) {
      return esc(text);
    },
    link({ href, title, tokens }) {
      const label = this.parser.parseInline(tokens);
      const t = title ? ` title="${esc(title)}"` : "";
      if (WEB.test(href)) return `<a href="${esc(href)}" target="_blank" rel="noopener"${t}>${label}</a>`;
      if (href.startsWith("#")) return `<a href="${esc(href)}"${t}>${label}</a>`;
      // A repo path: open it as a doc (markdown) or not at all.
      const p = join(base, href.split("#")[0]);
      return p ? `<a data-path="${esc(p)}"${t}>${label}</a>` : label;
    },
    image({ href, text }) {
      return WEB.test(href) ? `<img src="${esc(href)}" alt="${esc(text)}">` : esc(text);
    },
    code({ text, lang }) {
      if (!C_LANGS.has((lang || "").toLowerCase())) return `<pre><code>${esc(text)}</code></pre>`;
      const lines = tokenize(text, {}, null).map((toks) => toks.map((t) => (t.cls ? `<span class="t-${t.cls}">${esc(t.text)}</span>` : esc(t.text))).join(""));
      return `<pre><code>${lines.join("\n")}</code></pre>`;
    },
  },
});

/** `text` as HTML; relative links resolve against `file`'s folder. */
export function renderMarkdown(text, file) {
  base = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "";
  try {
    return marked.parse(text);
  } catch {
    return `<pre>${esc(text)}</pre>`;
  }
}

/** `rel` against folder `dir`, or null when it leaves the repo. */
function join(dir, rel) {
  const out = rel.startsWith("/") ? [] : dir.split("/").filter(Boolean);
  for (const part of rel.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!out.length) return null;
      out.pop();
    } else out.push(part);
  }
  return out.join("/");
}
