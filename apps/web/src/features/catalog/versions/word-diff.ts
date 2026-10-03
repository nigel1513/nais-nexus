/** One run of a word diff: kept, removed (only in `before`) or added (only in `after`). Whitespace stays with its run. */
export type DiffRun = { kind: "same" | "removed" | "added"; text: string };

/** LCS table cells (4 bytes each): about two 1,000-word texts. */
export const MAX_CELLS = 1_000_000;

/** Words with the whitespace after them attached (and any leading whitespace on its own), so runs read naturally. */
const tokens = (text: string) => text.match(/^\s+|\S+\s*/g) ?? [];

/**
 * Word-level diff of two texts (LCS over words; a word matches regardless of the whitespace after it), merged into
 * runs. Returns null when the texts are too long for the table: callers then show before / after whole, with a note.
 */
export function wordDiff(before: string, after: string): DiffRun[] | null {
  const a = tokens(before);
  const b = tokens(after);
  if ((a.length + 1) * (b.length + 1) > MAX_CELLS) return null;
  const w = b.length + 1;
  const lcs = new Uint32Array((a.length + 1) * w);
  for (let i = a.length - 1; i >= 0; i -= 1)
    for (let j = b.length - 1; j >= 0; j -= 1) lcs[i * w + j] = a[i]!.trimEnd() === b[j]!.trimEnd() ? lcs[(i + 1) * w + j + 1]! + 1 : Math.max(lcs[(i + 1) * w + j]!, lcs[i * w + j + 1]!);
  const runs: DiffRun[] = [];
  const push = (kind: DiffRun["kind"], text: string) => {
    const last = runs[runs.length - 1];
    if (last && last.kind === kind) last.text += text;
    else runs.push({ kind, text });
  };
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i]!.trimEnd() === b[j]!.trimEnd()) {
      push("same", b[j]!);
      i += 1;
      j += 1;
    } else if (lcs[(i + 1) * w + j]! >= lcs[i * w + j + 1]!) push("removed", a[i++]!);
    else push("added", b[j++]!);
  }
  while (i < a.length) push("removed", a[i++]!);
  while (j < b.length) push("added", b[j++]!);
  return runs;
}
