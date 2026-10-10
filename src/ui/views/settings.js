// Settings view: program settings, saved by the server to
// $XDG_CONFIG_HOME/codeviz/settings.json as soon as one changes.

import { $, api, el } from "../dom.js";

// The form, in order: [key, label, help, input].
const FIELDS = [
  ["Appearance"],
  ["transparent", "Transparent window", "The desktop shows through: no canvas background or grid, and the shell at the opacity below. The window reopens to apply it.", "bool"],
  ["shellOpacity", "Shell opacity", "Header, sidebar, tabs and pages in transparent mode.", "range"],
  ["canvasOpacity", "Canvas opacity", "The canvas's black background in transparent mode; the code boxes stay solid.", "range"],
  ["grid", "Dot grid", "The dots behind the canvas (opaque mode).", "bool"],
  ["Limits"],
  ["clusterMaxBoxes", "Boxes per cluster", "Past this, the rarer relations are kept first.", "number"],
  ["diffMaxFiles", "Files per commit view", "Files read from one commit or range.", "number"],
  ["diffMaxEntries", "Changes per commit view", "Change boxes kept, biggest first.", "number"],
  ["cacheMB", "Canvas cache (MB)", "Memory for drawn tiles; more keeps more zoom levels around.", "number"],
];

let onChange = () => {};

export function initSettings(changed) {
  onChange = changed;
}

export async function showSettings() {
  const r = await api("/api/settings");
  render(r);
}

function render(r) {
  const s = r.settings;
  const rows = [];
  for (const [key, label, help, type] of FIELDS) {
    if (!label) {
      rows.push(el("h3", {}, key));
      continue;
    }
    let input;
    if (type === "bool") {
      input = el("input", { type: "checkbox" });
      input.checked = s[key];
      input.onchange = () => save({ [key]: input.checked });
    } else if (type === "range") {
      input = el("input", { type: "range", min: "0", max: "1", step: "0.05", value: String(s[key]) });
      const out = el("span", { class: "val" }, s[key].toFixed(2));
      input.oninput = () => {
        out.textContent = Number(input.value).toFixed(2);
        // Preview while dragging; saved on release.
        onChange({ ...s, [key]: Number(input.value) });
      };
      input.onchange = () => save({ [key]: Number(input.value) });
      input = el("span", { class: "range" }, input, out);
    } else {
      input = el("input", { type: "number", value: String(s[key]) });
      input.onchange = () => save({ [key]: Number(input.value) });
    }
    const reset = el("button", { class: "reset", title: `Default: ${r.defaults[key]}` }, "Reset");
    reset.hidden = s[key] === r.defaults[key];
    reset.onclick = () => save({ [key]: r.defaults[key] });
    rows.push(el("div", { class: "set-row" }, el("div", {}, el("div", { class: "lbl" }, label), el("div", { class: "help" }, help)), input, reset));
  }
  rows.push(el("div", { class: "set-path" }, `Saved to ${r.path}`));
  $("set-form").replaceChildren(...rows);
}

async function save(patch) {
  const r = await api("/api/settings", patch);
  onChange(r.settings);
  render(r);
}
