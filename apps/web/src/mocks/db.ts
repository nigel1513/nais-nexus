import { createSeed } from "./fixtures";
import { enrichSeed } from "./fixtures-portal";
import type { MockDb } from "./types";

const KEY = "__naisMockDb";
type WithDb = typeof globalThis & { [KEY]?: MockDb };

/**
 * One in-memory store per server process (survives HMR via globalThis). Resets on restart.
 * The running mock app starts from the portal-volume seed (fixtures-portal.ts); unit tests reset to the bare
 * backend-seed mirror before each test (tests/setup.ts → resetDb()) and opt into the portal seed with `{ portal: true }`.
 */
export function getDb(): MockDb {
  const g = globalThis as WithDb;
  g[KEY] ??= seed(new Date(), true);
  return g[KEY];
}

export function resetDb(now: Date = new Date(), { portal = false }: { portal?: boolean } = {}): void {
  (globalThis as WithDb)[KEY] = seed(now, portal);
}

function seed(now: Date, portal: boolean): MockDb {
  const db = createSeed(now);
  return portal ? enrichSeed(db, now) : db;
}
