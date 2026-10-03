import type { Schemas } from "@/shared/api/types";
import { bridgeConfig, internalCall, type BridgeConfig } from "./notebook-activity";

// ---------------------------------------------------------------- bridge to the real search engine (discovery, D-049)

/**
 * When the web server runs in mock mode next to a real api (NAIS_INTERNAL_API_URL and NAIS_INTERNAL_TOKEN set), a text
 * search does not match substrings here: the demo catalogue's public metadata is kept in the api's demo indexes
 * (OpenSearch: nori analysis + bge-m3 embeddings) and searched there with the same query as the real searchDatasets
 * and the public project search. Unset, or the api or OpenSearch down: `null`, and the caller matches substrings as before.
 */
export const SYNC_TIMEOUT_MS = 30_000;
export const SEARCH_TIMEOUT_MS = 5_000;
/** After a failed call the bridge stays off this long, so a down api costs one timeout, not one per keystroke. */
export const RETRY_AFTER_MS = 30_000;

type IndexState = { synced: string | null; syncing: Promise<void> | null };
type BridgeState = { datasets: IndexState; projects: IndexState; downUntil: number };
const KEY = "__naisSearchBridge";
const state = (): BridgeState =>
  ((globalThis as Record<string, unknown>)[KEY] ??= { datasets: { synced: null, syncing: null }, projects: { synced: null, syncing: null }, downUntil: 0 }) as BridgeState;

/** Test hook: forget what was synced and that the bridge was down. */
export function resetSearchBridge() {
  delete (globalThis as Record<string, unknown>)[KEY];
}

/** The demo index is rewritten only when the documents changed (a dataset registered, published, renamed …). */
async function ensureSynced(cfg: BridgeConfig, index: IndexState, path: string, documents: unknown[]) {
  const fingerprint = JSON.stringify(documents);
  if (index.synced === fingerprint) return;
  index.syncing ??= internalCall<Schemas["InternalDemoSyncResult"]>(cfg, path, { method: "PUT", body: JSON.stringify({ documents }) }, SYNC_TIMEOUT_MS)
    .then(() => {
      index.synced = fingerprint;
    })
    .finally(() => {
      index.syncing = null;
    });
  await index.syncing;
  // Another request's sync ran: make sure this request's documents are the ones indexed.
  if (index.synced !== fingerprint) await ensureSynced(cfg, index, path, documents);
}

async function bridged<T>(run: (cfg: BridgeConfig) => Promise<T>): Promise<T | null> {
  const cfg = bridgeConfig();
  const s = state();
  if (!cfg || Date.now() < s.downUntil) return null;
  try {
    return await run(cfg);
  } catch (e) {
    s.downUntil = Date.now() + RETRY_AFTER_MS;
    console.warn(`[mock] search bridge unavailable (${e instanceof Error ? e.message : "error"}); matching text locally`);
    return null;
  }
}

/** searchDatasets through the demo dataset index; `documents` are the demo datasets as search index documents. */
export function searchDatasetsBridged(documents: () => Record<string, unknown>[], body: Schemas["InternalDemoDatasetSearchRequest"]): Promise<Schemas["DatasetSearchResult"] | null> {
  return bridged(async (cfg) => {
    await ensureSynced(cfg, state().datasets, "demo/datasets", documents());
    return internalCall<Schemas["DatasetSearchResult"]>(cfg, "demo/datasets/search", { method: "POST", body: JSON.stringify(body) }, SEARCH_TIMEOUT_MS);
  });
}

/** Ids of the public demo projects that match `q`, best first. */
export function searchProjectsBridged(documents: () => Schemas["InternalDemoProjectsRequest"]["documents"], q: string, limit: number): Promise<string[] | null> {
  return bridged(async (cfg) => {
    await ensureSynced(cfg, state().projects, "demo/projects", documents());
    const found = await internalCall<Schemas["InternalDemoProjectSearchResult"]>(cfg, "demo/projects/search", { method: "POST", body: JSON.stringify({ q, limit }) }, SEARCH_TIMEOUT_MS);
    return found.project_ids;
  });
}
