/**
 * jsdom has no layout: answer `(min-width: Npx)` / `(max-width: Npx)` media queries against a chosen width.
 * Reset to 1280 after each test (tests/setup.ts).
 */
export function mockViewport(width: number) {
  window.innerWidth = width;
  window.matchMedia = ((query: string) => {
    const min = /min-width:\s*(\d+)px/.exec(query);
    const max = /max-width:\s*(\d+)px/.exec(query);
    const matches = (!min || width >= Number(min[1])) && (!max || width <= Number(max[1])) && !/prefers-color-scheme:\s*dark/.test(query);
    return {
      matches,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    } as MediaQueryList;
  }) as typeof window.matchMedia;
}
