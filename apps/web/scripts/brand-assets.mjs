#!/usr/bin/env node
/**
 * Regenerates every brand file from one source: the mark in src/shared/ui/brand/mark.ts and the --color-brand-* /
 * --color-hero-* tokens in src/app/globals.css. Run after changing either, and commit the outputs:
 *
 *   corepack pnpm --filter @nais/web brand:assets
 *
 * Outputs (Next.js App Router file conventions, served without extra code):
 *   src/app/icon.svg                     favicon (vector, every modern browser)
 *   src/app/favicon.ico                  16 + 32px PNG-in-ICO fallback
 *   src/app/apple-icon.png               180px, full bleed (iOS rounds the corners)
 *   public/icons/icon-{192,512}.png      manifest icons (rounded tile)
 *   public/icons/icon-maskable-{192,512}.png  manifest maskable icons (full bleed, drawing inside the 80% safe zone)
 *   src/app/opengraph-image.png          1200×630 share image, Korean set in Pretendard
 *   src/app/twitter-image.png            the same image for twitter:image
 *
 * No new dependencies: sharp ships with Next (optional dependency, resolved from next's own folder) and Chromium comes
 * from @playwright/test, already used for e2e. Needs Node ≥ 22.18 (type stripping) to import mark.ts.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { markSvg } from "../src/shared/ui/brand/mark.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const at = (...p) => join(root, ...p);
const requireFromNext = createRequire(createRequire(at("package.json")).resolve("next/package.json"));
const sharp = requireFromNext("sharp");
const { chromium } = createRequire(at("package.json"))("@playwright/test");

/** First declaration of each token (the @theme block = light values; the brand and hero tokens are theme-independent). */
function token(css, name) {
  const m = css.match(new RegExp(`--color-${name}:\\s*(#[0-9a-fA-F]{6})`));
  if (!m) throw new Error(`token --color-${name} not found in globals.css`);
  return m[1];
}
const css = readFileSync(at("src/app/globals.css"), "utf8");
const colors = { tile: token(css, "brand-tile"), ring: token(css, "brand-ring"), cell: token(css, "brand-cell"), node: token(css, "brand-node") };
const hero = { fg: token(css, "hero-fg"), muted: token(css, "hero-fg-muted"), accent: token(css, "hero-accent") };

const png = (svg, size) => sharp(Buffer.from(svg), { density: 72 * (size / 32) * 2 }).resize(size, size).png({ compressionLevel: 9 }).toBuffer();
const write = (path, data) => {
  mkdirSync(dirname(at(path)), { recursive: true });
  writeFileSync(at(path), data);
  console.log("wrote", path, `${data.length} B`);
};

/** ICO with PNG payloads (Vista+ / every current browser). */
function ico(images) {
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, data }, i) => {
    const e = 6 + 16 * i;
    header.writeUInt8(size >= 256 ? 0 : size, e);
    header.writeUInt8(size >= 256 ? 0 : size, e + 1);
    header.writeUInt8(0, e + 2);
    header.writeUInt8(0, e + 3);
    header.writeUInt16LE(1, e + 4);
    header.writeUInt16LE(32, e + 6);
    header.writeUInt32LE(data.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...images.map((i) => i.data)]);
}

const rounded = markSvg(colors, { px: 32 });
const bleed = markSvg(colors, { px: 32, bleed: true, scale: 0.8 });

write("src/app/icon.svg", `${rounded}\n`);
write("src/app/favicon.ico", ico([{ size: 16, data: await png(rounded, 16) }, { size: 32, data: await png(rounded, 32) }]));
write("src/app/apple-icon.png", await png(bleed, 180));
write("public/icons/icon-192.png", await png(rounded, 192));
write("public/icons/icon-512.png", await png(rounded, 512));
write("public/icons/icon-maskable-192.png", await png(bleed, 192));
write("public/icons/icon-maskable-512.png", await png(bleed, 512));

// Share image: the hero band of the start page. A two-step title (muted context over the bold name), the mark, and a
// large orbit ring running off the right edge as the one decorative shape. No gradients (UI v2 rules).
const font = readFileSync(createRequire(at("package.json")).resolve("pretendard/dist/web/variable/woff2/PretendardVariable.woff2")).toString("base64");
// The mark's orbit at poster scale: a thin ring centred off the right edge, its satellite at 210°.
const [ocx, ocy, or] = [1130, 315, 300];
const sat = [ocx + or * Math.cos((210 * Math.PI) / 180), ocy + or * Math.sin((210 * Math.PI) / 180)];
const orbit = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630"><circle cx="${ocx}" cy="${ocy}" r="${or}" fill="none" stroke="${colors.ring}" stroke-width="2" opacity="0.55"/><circle cx="${ocx}" cy="${ocy}" r="${or - 64}" fill="none" stroke="${colors.ring}" stroke-width="1" opacity="0.22"/><circle cx="${sat[0]}" cy="${sat[1]}" r="11" fill="${colors.node}" stroke="${colors.tile}" stroke-width="6"/></svg>`;
const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><style>
  @font-face { font-family: P; src: url(data:font/woff2;base64,${font}) format("woff2"); font-weight: 45 920; }
  html, body { margin: 0; }
  body { width: 1200px; height: 630px; overflow: hidden; background: ${colors.tile}; color: ${hero.fg}; font-family: P, sans-serif; position: relative; word-break: keep-all; }
  .orbit { position: absolute; inset: 0; }
  .in { position: absolute; left: 88px; top: 88px; bottom: 80px; width: 720px; display: flex; flex-direction: column; }
  .mark { width: 72px; height: 72px; }
  .ctx { margin: 44px 0 0; font-size: 30px; font-weight: 600; letter-spacing: -0.02em; color: ${hero.muted}; }
  h1 { margin: 6px 0 0; font-size: 96px; line-height: 1.04; font-weight: 760; letter-spacing: -0.045em; }
  .lede { margin: 26px 0 0; font-size: 30px; line-height: 1.45; font-weight: 500; letter-spacing: -0.02em; color: ${hero.fg}; }
  .foot { margin-top: auto; display: flex; gap: 14px; align-items: center; font-size: 24px; font-weight: 600; letter-spacing: -0.01em; color: ${hero.accent}; }
  .foot i { width: 6px; height: 6px; border-radius: 50%; background: ${colors.node}; }
</style></head><body>
  <div class="orbit">${orbit}</div>
  <div class="in">
    <div class="mark">${markSvg(colors, { px: 72 })}</div>
    <p class="ctx">NAIS 국가과학AI연구센터</p>
    <h1>NAIS Commons</h1>
    <p class="lede">연구회 데이터를 찾고, 접근을 신청하고,<br>함께 분석하는 연구 데이터 포털</p>
    <p class="foot"><i></i>AI로 과학을, 과학으로 미래를</p>
  </div>
</body></html>`;
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  await page.setContent(html, { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
  const used = await page.evaluate(() => document.fonts.check('760 96px P', "국가"));
  if (!used) throw new Error("Pretendard did not load for the share image");
  const shot = await page.screenshot({ type: "png" });
  const og = await sharp(shot).png({ compressionLevel: 9, palette: false }).toBuffer();
  write("src/app/opengraph-image.png", og);
  write("src/app/twitter-image.png", og);
} finally {
  await browser.close();
}
const alt = "NAIS Commons — NAIS 국가과학AI연구센터의 연구 데이터 포털"; // no trailing newline: Next copies it into og:image:alt verbatim
write("src/app/opengraph-image.alt.txt", alt);
write("src/app/twitter-image.alt.txt", alt);
