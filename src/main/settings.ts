// Program settings, in $XDG_CONFIG_HOME/codeviz/settings.json (~/.config when
// unset). Workspaces and caches live elsewhere (workspace.ts).

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export interface Settings {
  // The window shows the desktop through it: no canvas background or grid,
  // and the shell (header, sidebar, tabs, pages) at `shellOpacity`.
  transparent: boolean;
  shellOpacity: number;
  // The canvas's black background in transparent mode.
  canvasOpacity: number;
  // The dot grid behind the canvas (opaque mode).
  grid: boolean;
  // Boxes kept in one symbol cluster; the rarer relations are kept first.
  clusterMaxBoxes: number;
  // Files read and change boxes kept in one commit view.
  diffMaxFiles: number;
  diffMaxEntries: number;
  // Memory for the canvas's cached tiles.
  cacheMB: number;
}

export const DEFAULTS: Settings = {
  transparent: false,
  shellOpacity: 0.75,
  canvasOpacity: 0.5,
  grid: true,
  clusterMaxBoxes: 600,
  diffMaxFiles: 400,
  diffMaxEntries: 800,
  cacheMB: 384,
};

// Bounds for the numbers.
const RANGES: Partial<Record<keyof Settings, [number, number]>> = {
  shellOpacity: [0, 1],
  canvasOpacity: [0, 1],
  clusterMaxBoxes: [10, 5000],
  diffMaxFiles: [10, 5000],
  diffMaxEntries: [10, 5000],
  cacheMB: [64, 4096],
};

export function settingsPath(): string {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "codeviz", "settings.json");
}

let current: Settings | null = null;

export function settings(): Settings {
  if (current) return current;
  let saved: Partial<Settings> = {};
  try {
    saved = JSON.parse(fs.readFileSync(settingsPath(), "utf8"));
  } catch {}
  current = clean(saved);
  return current;
}

/** Merges `patch` into the settings, saves them, and returns them. */
export function saveSettings(patch: Partial<Settings>): Settings {
  current = clean({ ...settings(), ...patch });
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(current, null, 2) + "\n");
  return current;
}

/** Known keys only, each of the default's type and within its range. */
function clean(s: Partial<Settings>): Settings {
  const out = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS) as (keyof Settings)[]) {
    const v = s[k];
    if (typeof v !== typeof DEFAULTS[k]) continue;
    if (typeof v === "number") {
      const [lo, hi] = RANGES[k] ?? [-Infinity, Infinity];
      if (!Number.isFinite(v)) continue;
      (out as any)[k] = Math.min(hi, Math.max(lo, v));
    } else (out as any)[k] = v;
  }
  return out;
}
