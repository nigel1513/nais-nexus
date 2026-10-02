/**
 * Generated sample data for the landing figure. It illustrates how a data card profiles a column; it is not real
 * data and carries no numbers, so nothing on the public page reads as a statistic. Seeded, so every render matches.
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

function scale(values: number[]): number[] {
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  return values.map((v) => (hi === lo ? 0 : (v - lo) / (hi - lo)));
}

/** 32 bins of a left-skewed cell-capacity distribution (most cells near nominal, a tail of faded ones). */
export function sampleHistogram(binCount = 32): number[] {
  const next = rng(18650);
  const bins = new Array<number>(binCount).fill(0);
  for (let i = 0; i < 2400; i += 1) {
    const faded = next() < 0.22;
    const x = faded ? 0.52 + normal(next) * 0.13 : 0.78 + normal(next) * 0.07;
    const bin = Math.floor(x * binCount);
    if (bin >= 0 && bin < binCount) bins[bin]! += 1;
  }
  const max = Math.max(...bins);
  return bins.map((b) => b / max);
}

export type SeriesKind = "voltage" | "temperature" | "capacity";

const SEEDS: Record<SeriesKind, number> = { voltage: 37, temperature: 25, capacity: 80 };

/** 48 points per cycle-indexed column, scaled to 0..1. */
export function sampleSeries(kind: SeriesKind, length = 48): number[] {
  const next = rng(SEEDS[kind]);
  const values = Array.from({ length }, (_, i) => {
    const t = i / (length - 1);
    const noise = normal(next);
    if (kind === "voltage") return 3.7 - 0.08 * t + 0.02 * Math.sin(i * 0.9) + noise * 0.008;
    if (kind === "temperature") return 25 + 1.6 * Math.sin(i * 0.45) + noise * 0.35;
    return 1 - 0.18 * t ** 1.4 + noise * 0.004;
  });
  return scale(values);
}
