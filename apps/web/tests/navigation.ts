import { useSyncExternalStore } from "react";
import { vi } from "vitest";

const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => void listeners.delete(fn);
};

const state = { pathname: "/", search: new URLSearchParams(), params: {} as Record<string, string> };

export function setLocation(href: string, params: Record<string, string> = {}) {
  const u = new URL(href, "http://localhost:3000");
  const changed = state.pathname !== u.pathname || state.search.toString() !== new URLSearchParams(u.search).toString();
  state.pathname = u.pathname;
  state.params = params;
  if (!changed) return; // a no-op navigation must not re-render (would loop redirect effects)
  state.search = new URLSearchParams(u.search);
  listeners.forEach((fn) => fn());
}

export const router = {
  push: vi.fn((href: string) => setLocation(href, state.params)),
  replace: vi.fn((href: string) => setLocation(href, state.params)),
  refresh: vi.fn(),
  back: vi.fn(),
  forward: vi.fn(),
  prefetch: vi.fn(),
};

export const navigationMock = {
  useRouter: () => router,
  usePathname: () => useSyncExternalStore(subscribe, () => state.pathname, () => state.pathname),
  // Reactive like the real hook, so Back/Forward (setLocation) re-renders subscribed screens.
  useSearchParams: () => useSyncExternalStore(subscribe, () => state.search, () => state.search),
  useParams: () => state.params,
  redirect: vi.fn(),
  notFound: vi.fn(),
};

export function resetNavigation() {
  setLocation("/");
  for (const fn of Object.values(router)) fn.mockClear();
}
