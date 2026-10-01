const TZ = "Asia/Seoul";
const parts = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function pick(iso: string) {
  const map = Object.fromEntries(parts.formatToParts(new Date(iso)).map((p) => [p.type, p.value]));
  return map as Record<"year" | "month" | "day" | "hour" | "minute", string>;
}

/** "YYYY-MM-DD HH:mm" in Asia/Seoul. Callers put the UTC original in a title attribute (M10 §7). */
export function formatDateTime(iso: string): string {
  const p = pick(iso);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

export function formatDate(iso: string): string {
  const p = pick(iso);
  return `${p.year}-${p.month}-${p.day}`;
}

export type ExpiryParts = { key: "common.expired" | "common.expiresInDays" | "common.expiresInHours"; count: number };

export function expiryParts(iso: string, now: number = Date.now()): ExpiryParts {
  const ms = Date.parse(iso) - now;
  if (ms <= 0) return { key: "common.expired", count: 0 };
  const hours = Math.ceil(ms / 3_600_000);
  if (hours < 24) return { key: "common.expiresInHours", count: hours };
  return { key: "common.expiresInDays", count: Math.floor(ms / 86_400_000) };
}

const UNITS = ["KiB", "MiB", "GiB", "TiB"] as const;

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${UNITS[unit]}`;
}

export function shortHash(sha: string): string {
  return sha.length <= 12 ? sha : `${sha.slice(0, 8)}…${sha.slice(-4)}`;
}
