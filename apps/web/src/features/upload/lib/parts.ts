export type PartRange = { partNumber: number; start: number; end: number };

export function planParts(size: number, partSize: number): PartRange[] {
  if (!(partSize > 0)) throw new Error("part size must be positive");
  const out: PartRange[] = [];
  for (let start = 0, partNumber = 1; start < size; start += partSize, partNumber += 1) {
    out.push({ partNumber, start, end: Math.min(start + partSize, size) });
  }
  return out;
}
