/** One run of a word diff: kept, removed (only in `before`) or added (only in `after`). Whitespace stays with its run. */
export type DiffRun = { kind: "same" | "removed" | "added"; text: string };

const MAX_CELLS = 250_000;

/**
 * Word-level diff of two texts (LCS over whitespace-separated tokens, whitespace kept), merged into runs. Returns null
 * when the texts are too long for the table (callers then show before / after whole).
 */
export function wordDiff(before: string, after: string): DiffRun[] | null {
  const a = before.split(/(\s+)/).filter(Boolean);
  const b = after.split(/(\s+)/).filter(Boolean);
  if ((a.length + 1) * (b.length + 1) > MAX_CELLS) return null;
  const w = b.length + 1;
  const lcs = new Uint32Array((a.length + 1) * w);
  for (let i = a.length - 1; i >= 0; i -= 1)
    for (let j = b.length - 1; j >= 0; j -= 1) lcs[i * w + j] = a[i] === b[j] ? lcs[(i + 1) * w + j + 1]! + 1 : Math.max(lcs[(i + 1) * w + j]!, lcs[i * w + j + 1]!);
  const runs: DiffRun[] = [];
  const push = (kind: DiffRun["kind"], text: string) => {
    const last = runs[runs.length - 1];
    if (last && last.kind === kind) last.text += text;
    else runs.push({ kind, text });
  };
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      push("same", a[i]!);
      i += 1;
      j += 1;
    } else if (lcs[(i + 1) * w + j]! >= lcs[i * w + j + 1]!) push("removed", a[i++]!);
    else push("added", b[j++]!);
  }
  while (i < a.length) push("removed", a[i++]!);
  while (j < b.length) push("added", b[j++]!);
  return runs;
}
