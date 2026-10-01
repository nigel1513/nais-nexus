import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ENUMS, ERROR_CODES } from "@/generated/contracts";
import en from "@/messages/en.json";
import ko from "@/messages/ko.json";
import YAML from "yaml";
import { loadMessages, lookup, missingKeys } from "./messages";

describe("ko messages", () => {
  it("has a Korean message for every contract error code (M10-AT-04)", () => {
    const missing = ERROR_CODES.filter((code) => !lookup(ko, `errors.${code}`));
    expect(missing).toEqual([]);
    expect(lookup(ko, "errors.fallback")).toContain("추적 ID");
  });

  it("labels every openapi enum value under enums.<Schema>.<VALUE>", () => {
    const missing = Object.entries(ENUMS).flatMap(([schema, values]) =>
      (values as readonly string[]).filter((v) => !lookup(ko, `enums.${schema}.${v}`)).map((v) => `enums.${schema}.${v}`),
    );
    expect(missing).toEqual([]);
  });

  it("has no empty strings", () => {
    const empty: string[] = [];
    const walk = (tree: Record<string, unknown>, prefix: string) => {
      for (const [k, v] of Object.entries(tree)) {
        if (typeof v === "string") {
          if (!v.trim()) empty.push(prefix + k);
        } else walk(v as Record<string, unknown>, `${prefix}${k}.`);
      }
    };
    walk(ko, "");
    expect(empty).toEqual([]);
  });
});

describe("en messages", () => {
  it("missing en keys only warn and fall back to ko", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const missing = missingKeys(ko, en);
    if (missing.length) console.warn(`en.json is missing ${missing.length} keys (falls back to ko)`);
    const merged = loadMessages("en");
    expect(missingKeys(ko, merged)).toEqual([]);
    expect(lookup(merged, "nav.dashboard")).toBe("Dashboard");
    warn.mockRestore();
  });
  it("has no keys that ko lacks", () => {
    expect(missingKeys(en, ko)).toEqual([]);
  });
});

describe("contract drift (reads NAIS_PRD/contracts directly, not the generated file)", () => {
  const root = path.resolve(__dirname, "../../../..");
  const contracts = path.join(root, "NAIS_PRD", "contracts");

  it("ko has errors.<CODE> for every code in error_codes.json", () => {
    const codes: { code: string }[] = JSON.parse(readFileSync(path.join(contracts, "error_codes.json"), "utf8")).codes;
    expect(codes.length).toBeGreaterThan(0);
    expect(codes.filter((c) => !lookup(ko, `errors.${c.code}`)).map((c) => c.code)).toEqual([]);
  });

  it("ko has enums.<Schema>.<VALUE> for every enum schema value in openapi.yaml", () => {
    const api = YAML.parse(readFileSync(path.join(contracts, "openapi.yaml"), "utf8"));
    const missing: string[] = [];
    let seen = 0;
    for (const [name, schema] of Object.entries<{ enum?: string[] }>(api.components.schemas)) {
      if (!Array.isArray(schema.enum)) continue;
      seen += 1;
      for (const v of schema.enum) if (!lookup(ko, `enums.${name}.${v}`)) missing.push(`enums.${name}.${v}`);
    }
    expect(seen).toBeGreaterThan(0);
    expect(missing).toEqual([]);
  });

  it("generated contracts.ts is fully up to date (ERROR_HTTP, ERROR_CODES, ENUMS)", () => {
    const script = path.resolve(__dirname, "../../scripts/sync-contracts.mjs");
    expect(() => execFileSync(process.execPath, [script, "--check"], { stdio: "pipe" })).not.toThrow();
  });

  it("user-visible ko copy has no dev-phase wording", () => {
    const text = JSON.stringify(ko);
    for (const bad of ["Wave", "P1", "개발 환경", "Mock", "seed", "Keycloak"]) expect(text).not.toContain(bad);
  });
});
