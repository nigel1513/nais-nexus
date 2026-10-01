import { vi } from "vitest";

const state = { pathname: "/", search: new URLSearchParams(), params: {} as Record<string, string> };

export function setLocation(href: string, params: Record<string, string> = {}) {
  const u = new URL(href, "http://localhost:3000");
  state.pathname = u.pathname;
  state.search = new URLSearchParams(u.search);
  state.params = params;
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
  usePathname: () => state.pathname,
  useSearchParams: () => state.search,
  useParams: () => state.params,
  redirect: vi.fn(),
  notFound: vi.fn(),
};

export function resetNavigation() {
  setLocation("/");
  for (const fn of Object.values(router)) fn.mockClear();
}
