import { MARK, MARK_TOKENS } from "./mark";

/** The NAIS Commons mark (same shapes as app/icon.svg), coloured from the brand tokens. Decorative: pair it with the name. */
export function BrandMark({ className }: { className?: string }) {
  const { size, tileRadius, ring, cell, cells, satellite } = MARK;
  const c = MARK_TOKENS;
  return (
    <svg viewBox={`0 0 ${size} ${size}`} aria-hidden="true" focusable="false" className={className} data-brand-mark="">
      <rect width={size} height={size} rx={tileRadius} fill={c.tile} />
      <circle cx={ring.cx} cy={ring.cy} r={ring.r} fill="none" stroke={c.ring} strokeWidth={ring.width} />
      {cells.map(([x, y, node]) => (
        <rect key={`${x}-${y}`} x={x} y={y} width={cell} height={cell} fill={node ? c.node : c.cell} />
      ))}
      <circle cx={satellite.cx} cy={satellite.cy} r={satellite.r} fill={c.node} stroke={c.tile} strokeWidth={satellite.cut} />
    </svg>
  );
}
