// Source blocks: a declaration's lines plus the comments that belong to it, the
// way an editor shows them on hover.

const MAX_COMMENT_LINES = 80;
const TAB = 4;

/** The 1-based inclusive range of a declaration at [start, end] with its comments. */
export function blockRange(lines: string[], start: number, end: number): { start: number; end: number } {
  return { start: leadingStart(lines, start), end: trailingEnd(lines, end) };
}

/** Walks up over comment lines that touch the declaration (no blank line between). */
export function leadingStart(lines: string[], start: number): number {
  let first = start;
  let i = start - 2;
  while (i >= 0 && start - i <= MAX_COMMENT_LINES) {
    const t = lines[i].trim();
    if (t.startsWith("//")) {
      first = i + 1;
      i--;
    } else if (t.endsWith("*/")) {
      let j = i;
      while (j >= 0 && !lines[j].includes("/*")) j--;
      if (j < 0 || !lines[j].trim().startsWith("/*")) break;
      first = j + 1;
      i = j - 1;
    } else break;
  }
  return first;
}

/**
 * Takes comment lines right after the declaration, but only when a blank line
 * (or the end of the file) follows them; otherwise they lead the next declaration.
 */
export function trailingEnd(lines: string[], end: number): number {
  let i = end;
  while (i < lines.length && end - i < MAX_COMMENT_LINES) {
    const t = lines[i].trim();
    if (t.startsWith("//")) i++;
    else if (t.startsWith("/*")) {
      while (i < lines.length && !lines[i].includes("*/")) i++;
      i++;
    } else break;
  }
  if (i > end && (i >= lines.length || lines[i].trim() === "")) return Math.min(i, lines.length);
  return end;
}

export function expandTabs(line: string): string {
  if (!line.includes("\t")) return line;
  let out = "";
  for (const ch of line) {
    if (ch === "\t") out += " ".repeat(TAB - (out.length % TAB));
    else out += ch;
  }
  return out;
}

/** Drops the indentation every non-blank line shares. */
export function dedent(lines: string[]): string[] {
  let common = Infinity;
  for (const l of lines) if (l.trim()) common = Math.min(common, l.length - l.trimStart().length);
  return common === Infinity || common === 0 ? lines : lines.map((l) => l.slice(common));
}
