// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./globals.css", import.meta.url), "utf8");

function tokens(block: string): Record<string, string> {
  return Object.fromEntries([...block.matchAll(/--color-([a-z0-9-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1], m[2]]));
}
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

describe("design tokens", () => {
  it.each(["--color-bg:", "--color-fg-muted:", "--color-primary:", "--color-accent:", "--radius-sm:", "--ease-out:", "--font-sans:"])(
    "declares %s",
    (token) => expect(css).toContain(token),
  );
  it("defines a dark variant for every color token", () => {
    // Start at the `.dark {` rule itself, not at the `@custom-variant dark (... .dark ...)` line.
    const darkStart = css.search(/^\.dark\s*\{/m);
    expect(darkStart).toBeGreaterThan(-1);
    const darkBlock = css.slice(darkStart);
    const theme = css.slice(0, css.search(/^\.light\s*\{/m));
    // Legacy aliases that point at another token (`var(--color-...)`) inherit the dark value.
    const light = [...theme.matchAll(/--color-([a-z0-9-]+):(?!\s*var\()/g)].map((m) => m[1]);
    expect(light.length).toBeGreaterThan(20);
    for (const name of new Set(light)) expect(darkBlock, name).toContain(`--color-${name}:`);
  });
  it("uses only the three radii", () => {
    expect(css).toMatch(/--radius-sm:\s*6px/);
    expect(css).toMatch(/--radius-md:\s*10px/);
    expect(css).toMatch(/--radius-lg:\s*14px/);
    expect([...css.matchAll(/--radius-([a-z0-9]+):/g)].map((m) => m[1]).sort()).toEqual(["lg", "md", "sm"]);
  });
  it.each(["light", "dark"] as const)("%s: text tokens meet WCAG AA (4.5:1) on page, panel and their soft fill", (mode) => {
    const darkStart = css.search(/^\.dark\s*\{/m);
    const light = tokens(css.slice(0, darkStart));
    const t = mode === "light" ? light : { ...light, ...tokens(css.slice(darkStart)) };
    const surfaces = ["bg", "bg-subtle", "bg-panel"];
    const text: Array<[string, string | null]> = [
      ["fg", null], ["fg-muted", null], ["accent-fg", "accent-soft"],
      ["success", "success-soft"], ["warning", "warning-soft"], ["danger", "danger-soft"], ["info", "info-soft"],
    ];
    for (const [fg, soft] of text) {
      for (const bg of soft ? [...surfaces, soft] : surfaces) {
        expect(contrast(t[fg]!, t[bg]!), `${mode} ${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
  it("repeats the light values under .light (forced-light subtrees)", () => {
    const lightStart = css.search(/^\.light\s*\{/m);
    const darkStart = css.search(/^\.dark\s*\{/m);
    expect(lightStart).toBeGreaterThan(-1);
    expect(tokens(css.slice(lightStart, darkStart))).toEqual(tokens(css.slice(0, lightStart)));
  });
  it.each(["light", "dark"] as const)("%s: filled buttons keep their label at 4.5:1 on the fill and its hover", (mode) => {
    const darkStart = css.search(/^\.dark\s*\{/m);
    const light = tokens(css.slice(0, darkStart));
    const t = mode === "light" ? light : { ...light, ...tokens(css.slice(darkStart)) };
    const pairs: Array<[string, string]> = [
      ["primary-fg", "primary"], ["primary-fg", "primary-hover"],
      ["danger-fill-fg", "danger-fill"], ["danger-fill-fg", "danger-fill-hover"],
    ];
    for (const [fg, bg] of pairs) expect(contrast(t[fg]!, t[bg]!), `${mode} ${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
  });
  it("reduced motion removes transforms, including press feedback", () => {
    const block = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(block).toMatch(/\.press:active[^{]*\{[^}]*transform:\s*none/);
    expect(block).toMatch(/\[data-starting-style\][^{]*\{[^}]*scale:\s*none/);
  });
});
