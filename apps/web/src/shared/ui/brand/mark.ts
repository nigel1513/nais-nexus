/**
 * The NAIS Commons mark, drawn on a 16px grid so the favicon stays crisp at its real size: a dark tile (the parent
 * site's family), an orbit ring, and a 2×2 block of data cells — the shared commons — with one cell and the satellite
 * on the ring in the node colour. Every rectangle sits on whole pixels at 16px.
 *
 * Plain data and string building only (no JSX, no TS-only runtime syntax): scripts/brand-assets.mjs imports this file
 * directly with Node's type stripping, and BrandMark renders the same shapes, so the files and the shell never drift.
 */
export const MARK = {
  size: 16,
  tileRadius: 3.5,
  ring: { cx: 8, cy: 8, r: 5.5, width: 1 },
  cell: 2,
  /** [x, y, node?]: the lower-left cell carries the node colour, diagonal to the satellite. */
  cells: [
    [5, 5, false],
    [9, 5, false],
    [5, 9, true],
    [9, 9, false],
  ],
  /** On the ring at 60° (clear of the upper-right cell); a tile-coloured stroke cuts the ring around it. */
  satellite: { cx: 10.75, cy: 3.24, r: 1.3, cut: 0.5 },
} as const;

export type MarkColors = { tile: string; ring: string; cell: string; node: string };

/** CSS custom properties from globals.css: the shell's mark follows the tokens. */
export const MARK_TOKENS: MarkColors = {
  tile: "var(--color-brand-tile)",
  ring: "var(--color-brand-ring)",
  cell: "var(--color-brand-cell)",
  node: "var(--color-brand-node)",
};

/**
 * Standalone SVG. `bleed`: a square tile with no rounded corners (app icons the platform masks itself: apple-icon,
 * maskable). `scale`: the drawing inside the tile, around its centre (0.8 keeps the satellite inside the 80% safe zone).
 */
export function markSvg(colors: MarkColors, { px = 32, bleed = false, scale = 1 }: { px?: number; bleed?: boolean; scale?: number } = {}): string {
  const { size, tileRadius, ring, cell, cells, satellite } = MARK;
  const c = size / 2;
  const inner = [
    `<circle cx="${ring.cx}" cy="${ring.cy}" r="${ring.r}" fill="none" stroke="${colors.ring}" stroke-width="${ring.width}"/>`,
    ...cells.map(([x, y, node]) => `<rect x="${x}" y="${y}" width="${cell}" height="${cell}" fill="${node ? colors.node : colors.cell}"/>`),
    `<circle cx="${satellite.cx}" cy="${satellite.cy}" r="${satellite.r}" fill="${colors.node}" stroke="${colors.tile}" stroke-width="${satellite.cut}"/>`,
  ].join("");
  const body = scale === 1 ? inner : `<g transform="translate(${c} ${c}) scale(${scale}) translate(${-c} ${-c})">${inner}</g>`;
  const tile = `<rect width="${size}" height="${size}"${bleed ? "" : ` rx="${tileRadius}"`} fill="${colors.tile}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 ${size} ${size}">${tile}${body}</svg>`;
}
