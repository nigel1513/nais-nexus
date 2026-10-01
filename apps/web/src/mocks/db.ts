import { createSeed } from "./fixtures";
import type { MockDb } from "./types";

const KEY = "__naisMockDb";
type WithDb = typeof globalThis & { [KEY]?: MockDb };

/** One in-memory store per server process (survives HMR via globalThis). Resets on restart. */
export function getDb(): MockDb {
  const g = globalThis as WithDb;
  g[KEY] ??= createSeed(new Date());
  return g[KEY];
}

export function resetDb(now: Date = new Date()): void {
  (globalThis as WithDb)[KEY] = createSeed(now);
}
