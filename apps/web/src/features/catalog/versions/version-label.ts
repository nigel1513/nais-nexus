/** R12 version-number guidance: small change -> next minor, big change -> next major. Labels stay free text. */
export function suggestNextLabels(latest: string | null): { minor: string; major: string } | null {
  if (latest === null) return { minor: "v1.0", major: "v1.0" };
  const m = /^(v?)(\d+)(?:\.(\d+))?(?:\.\d+)?$/.exec(latest);
  if (!m) return null;
  const [, prefix = "", major = "0", minor] = m;
  return { minor: `${prefix}${major}.${Number(minor ?? 0) + 1}`, major: `${prefix}${Number(major) + 1}.0` };
}
