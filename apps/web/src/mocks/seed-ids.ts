/** Seed ids shared by fixtures.ts and the modules it builds on (recipes.ts reads the seed tables by dataset/version). */
export const sid = (suffix: string) => `00000000-0000-7000-8000-${suffix.padStart(12, "0")}`;
export const hex = (n: number) => n.toString(16).padStart(64, "0");
export const DATASET = { battery: sid("2001"), openMaterials: sid("2002"), qcLogs: sid("2003"), sensors: sid("2004"), electrolyte: sid("2005") } as const;
export const VERSION = { batteryV10: sid("2111"), batteryV11: sid("2112"), batteryDraft: sid("2113"), battery: sid("2101"), openMaterials: sid("2102"), qcLogs: sid("2103"), sensors: sid("2104"), electrolyte: sid("2105") } as const;
