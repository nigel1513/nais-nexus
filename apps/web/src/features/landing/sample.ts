/**
 * Generated example columns for the landing page's data card previews. They show how a data card profiles columns;
 * they are not real data, and every panel that shows them says so. Seeded, so server, client and screenshots match.
 */

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normal(next: () => number) {
  return Math.sqrt(-2 * Math.log(1 - next())) * Math.cos(2 * Math.PI * next());
}

export type SampleColumn = {
  name: string;
  type: "float" | "int";
  lo: number;
  hi: number;
  digits: number;
  unit: string;
  bins: number[];
  /** Index of the tallest bin; it and its neighbours are drawn in the accent colour. */
  peak: number;
};

export const SAMPLE_BINS = 22;

const SPECS: Array<Omit<SampleColumn, "bins" | "peak"> & { draw: (next: () => number) => number }> = [
  { name: "capacity_ah", type: "float", lo: 2.2, hi: 3.2, digits: 2, unit: "Ah", draw: (n) => (n() < 0.22 ? 2.62 + normal(n) * 0.12 : 2.98 + normal(n) * 0.06) },
  { name: "voltage_v", type: "float", lo: 3.5, hi: 3.9, digits: 2, unit: "V", draw: (n) => 3.71 + normal(n) * 0.045 },
  { name: "temp_c", type: "float", lo: 22, hi: 34, digits: 1, unit: "", draw: (n) => (n() < 0.3 ? 29.5 + normal(n) * 1.4 : 25.6 + normal(n) * 0.9) },
  { name: "cycle", type: "int", lo: 0, hi: 1000, digits: 0, unit: "", draw: (n) => n() * 1000 * Math.sqrt(n()) },
];

export const SAMPLE_COLUMNS: SampleColumn[] = SPECS.map(({ draw, ...spec }, k) => {
  const next = rng(1865 + k * 131);
  const bins = new Array<number>(SAMPLE_BINS).fill(0);
  for (let i = 0; i < 2600; i += 1) {
    const bin = Math.floor(((draw(next) - spec.lo) / (spec.hi - spec.lo)) * SAMPLE_BINS);
    if (bin >= 0 && bin < SAMPLE_BINS) bins[bin]! += 1;
  }
  return { ...spec, bins, peak: bins.indexOf(Math.max(...bins)) };
});

/** Lower and upper edge of a bin, formatted with the column's digits. */
export function binRange(column: SampleColumn, bin: number): [string, string] {
  const at = (i: number) => (column.lo + ((column.hi - column.lo) * i) / SAMPLE_BINS).toFixed(column.digits);
  return [at(bin), at(bin + 1)];
}
