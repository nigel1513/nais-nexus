// @vitest-environment node
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { markSvg } from "@/shared/ui/brand/mark";
import manifest from "./manifest";

const file = (p: string) => new URL(p, import.meta.url);
const css = readFileSync(file("./globals.css"), "utf8");
const token = (name: string) => css.match(new RegExp(`--color-${name}:\\s*(#[0-9a-f]{6})`, "i"))![1]!;

/** Width × height from a PNG's IHDR chunk. */
function pngSize(buf: Buffer): [number, number] {
  expect(buf.subarray(1, 4).toString("latin1")).toBe("PNG");
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
}

describe("web app manifest", () => {
  const m = manifest();

  it("names the product and uses the light page colour", () => {
    expect(m.short_name).toBe("NAIS Commons");
    expect(m.name).toContain("NAIS Commons");
    expect(m.theme_color).toBe(token("bg"));
    expect(m.background_color).toBe(token("bg"));
    expect(m.start_url).toBe("/commons");
  });

  it("lists 192 and 512 icons, maskable included, and every file exists at its stated size", () => {
    const icons = m.icons ?? [];
    for (const size of ["192x192", "512x512"]) {
      expect(icons.some((i) => i.sizes === size && i.purpose === "any")).toBe(true);
      expect(icons.some((i) => i.sizes === size && i.purpose === "maskable")).toBe(true);
    }
    for (const icon of icons) {
      if (icon.type !== "image/png") continue;
      const [w, h] = pngSize(readFileSync(file(`../../public${icon.src}`)));
      expect(`${w}x${h}`, icon.src).toBe(icon.sizes);
    }
  });
});

describe("brand files (scripts/brand-assets.mjs)", () => {
  it("icon.svg is the current mark in the current brand tokens (rerun brand:assets after changing either)", () => {
    const colors = { tile: token("brand-tile"), ring: token("brand-ring"), cell: token("brand-cell"), node: token("brand-node") };
    expect(readFileSync(file("./icon.svg"), "utf8").trim()).toBe(markSvg(colors, { px: 32 }));
  });

  it("favicon.ico carries 16 and 32px images", () => {
    const ico = readFileSync(file("./favicon.ico"));
    expect(ico.readUInt16LE(2)).toBe(1);
    const count = ico.readUInt16LE(4);
    expect([...Array(count).keys()].map((i) => ico.readUInt8(6 + 16 * i))).toEqual([16, 32]);
  });

  it.each([
    ["./apple-icon.png", [180, 180]],
    ["./opengraph-image.png", [1200, 630]],
    ["./twitter-image.png", [1200, 630]],
  ] as const)("%s is %j", (path, size) => {
    expect(pngSize(readFileSync(file(path)))).toEqual(size);
  });

  it("share images have alt text", () => {
    for (const p of ["./opengraph-image.alt.txt", "./twitter-image.alt.txt"]) {
      expect(existsSync(file(p))).toBe(true);
      expect(readFileSync(file(p), "utf8")).toContain("NAIS Commons");
    }
  });
});
