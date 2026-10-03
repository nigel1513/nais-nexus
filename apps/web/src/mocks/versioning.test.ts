import { describe, expect, it } from "vitest";
import { creatorsFromSnapshot, diffFiles, diffMetadata, diffSchema, fileHistory, renderCitation, summarize, threeWay, type CitationInput } from "./versioning";

const f = (path: string, sha: string, size = 1) => ({ path, sha256: sha.repeat(64).slice(0, 64), size_bytes: size });

describe("versioning mock rules (mirror backend)", () => {
  it("diffs by path and sha", () => {
    const changes = diffFiles([f("x.csv", "a", 10), f("gone.csv", "b", 5)], [f("x.csv", "b", 12), f("new.csv", "a", 3)]);
    expect(changes.map((c) => [c.path, c.status, c.size_delta])).toEqual([
      ["gone.csv", "REMOVED", -5],
      ["new.csv", "ADDED", 3],
      ["x.csv", "CHANGED", 2],
    ]);
    expect(summarize(changes)).toEqual({ added: 1, removed: 1, changed: 1, unchanged: 0 });
  });

  it("treats a re-upload with the same content as unchanged", () => {
    expect(diffFiles([f("a", "a")], [f("a", "a")])[0]!.status).toBe("UNCHANGED");
  });

  it.each([
    ["b", "b", "t", "theirs"],
    ["b", "m", "b", "mine"],
    ["b", "m", "m", "mine"],
    ["b", "m", "t", "conflict"],
    ["b", null, "t", "conflict"],
    [null, "m", null, "mine"],
    ["b", "b", null, "theirs"],
    ["b", "b", "b", "noop"],
    [null, "m", "x", "conflict"],
  ] as const)("three-way %s/%s/%s -> %s", (b, m, t, expected) => {
    const side = (v: string | null): Record<string, string> => (v === null ? {} : { p: v });
    const plan = threeWay(side(b), side(m), side(t), {});
    const got = plan.takeTheirs.includes("p") ? "theirs" : plan.keepMine.includes("p") ? "mine" : plan.conflicts.length ? "conflict" : "noop";
    expect(got).toBe(expected);
    if (expected === "conflict") expect(plan.conflicts).toEqual([{ path: "p", base: b, mine: m, theirs: t }]);
  });

  it("settles conflicts with resolutions and rejects non-conflict paths", () => {
    expect(threeWay({ p: "b" }, { p: "m" }, { p: "t" }, { p: "THEIRS" }).takeTheirs).toEqual(["p"]);
    expect(threeWay({ p: "b" }, { p: "m" }, { p: "t" }, { p: "MINE" }).keepMine).toEqual(["p"]);
    expect(() => threeWay({ p: "b" }, { p: "m" }, { p: "t" }, { q: "MINE" })).toThrow("UNKNOWN_PATH");
  });

  it("builds file history over published versions", () => {
    const versions = [
      { dataset_version_id: "1", version_label: "v1", published_at: "2026-01-01T00:00:00Z", files: [f("a", "a")] },
      { dataset_version_id: "2", version_label: "v2", published_at: "2026-02-01T00:00:00Z", files: [f("a", "b")] },
      { dataset_version_id: "3", version_label: "v3", published_at: "2026-03-01T00:00:00Z", files: [] },
      { dataset_version_id: "4", version_label: "v4", published_at: "2026-04-01T00:00:00Z", files: [] },
    ];
    expect(fileHistory(versions, "a").map((i) => i.state)).toEqual(["ADDED", "CHANGED", "REMOVED", "ABSENT"]);
    expect(fileHistory(versions.slice(0, 1).concat({ ...versions[1]!, files: [f("a", "a")] }), "a").map((i) => i.state)).toEqual(["ADDED", "UNCHANGED"]);
  });

  it("schema layer reports structure only and flags missing profiles", () => {
    const col: { name: string; type: string; unit: string | null; missing_ratio: number } = { name: "x", type: "integer", unit: null, missing_ratio: 0.1 };
    const got = diffSchema(
      "d.csv",
      { total_rows: 10, columns: [col, { name: "old", type: "string", missing_ratio: 0 }] },
      { total_rows: 9, columns: [{ ...col, type: "number", unit: "Cel", missing_ratio: 0.3, top_values: [{ value: "secret" }] } as typeof col, { name: "z", type: "string", missing_ratio: 0 }] },
    );
    expect(got).toEqual({
      path: "d.csv",
      status: "COMPARED",
      rows: [10, 9],
      columns_added: ["z"],
      columns_removed: ["old"],
      columns_changed: [{ name: "x", type: ["integer", "number"], unit: [null, "Cel"], missing_ratio: [0.1, 0.3] }],
    });
    expect(JSON.stringify(got)).not.toContain("secret");
    expect(diffSchema("d.csv", { columns: [col] }, { columns: [{ ...col, missing_ratio: 0.1001 }] }).columns_changed).toEqual([]);
    expect(diffSchema("d.csv", null, { columns: [] })).toEqual({ path: "d.csv", status: "PROFILE_MISSING" });
  });

  it("metadata layer flattens and treats missing as null", () => {
    const pi = { display_name: "B", affiliation: { name: "Institute B" } };
    expect(diffMetadata({ license: "CC-BY-4.0", keywords: ["a"], title: "T" }, { license: "CC0-1.0", keywords: ["a"], title: "T", people: { principal_investigator: pi } })).toEqual([
      { field: "license", before: "CC-BY-4.0", after: "CC0-1.0" },
      { field: "people.principal_investigator", before: null, after: pi },
    ]);
  });
});

const C: CitationInput = {
  title: "Battery Cycling Measurements",
  version_label: "v2.0",
  year: 2026,
  publisher: "Institute B",
  uri: "http://localhost:21051/id/dataset-version/abc",
  doi: null,
  license: "CC-BY-4.0",
  creators: [
    { name: "홍길동", affiliation: "Institute B", ntis: "10000002" },
    { name: "B Researcher", affiliation: "Institute A", ntis: null },
  ],
};

describe("citation", () => {
  it("renders text", () => {
    expect(renderCitation("text", C)).toBe("홍길동, B Researcher (2026). Battery Cycling Measurements (Version v2.0) [Data set]. Institute B. http://localhost:21051/id/dataset-version/abc");
    expect(renderCitation("text", { ...C, doi: "10.1000/x" })).toContain("https://doi.org/10.1000/x");
  });
  it("renders bibtex with escapes", () => {
    const out = renderCitation("bibtex", C);
    expect(out.startsWith("@misc{nais_abc,\n")).toBe(true);
    expect(out).toContain("  author = {홍길동 and B Researcher},\n");
    expect(out).toContain("  version = {v2.0},\n");
    expect(renderCitation("bibtex", { ...C, title: "A {b} & c" })).toContain("A \\{b\\} \\& c");
  });
  it("renders DataCite JSON", () => {
    const data = JSON.parse(renderCitation("datacite-json", C));
    expect(data.creators[0]).toEqual({ name: "홍길동", nameType: "Personal", affiliation: [{ name: "Institute B" }], nameIdentifiers: [{ nameIdentifier: "10000002", nameIdentifierScheme: "NTIS" }] });
    expect(data.creators[1].nameIdentifiers).toBeUndefined();
    expect(data.identifiers).toEqual([{ identifier: C.uri, identifierType: "URL" }]);
    expect(data.publicationYear).toBe("2026");
    expect(data.rightsList).toEqual([{ rights: "CC-BY-4.0" }]);
    expect(Object.keys(data)).toEqual([...Object.keys(data)].sort());
  });
  it("derives creators from the snapshot with an organization fallback", () => {
    const snap = {
      people: {
        principal_investigator: { display_name: "홍길동", affiliation: { name: "Institute B" }, national_researcher_number: "10000002" },
        contributors: [
          { display_name: "Co", role: "CO_INVESTIGATOR", affiliation: { name: "Institute A" } },
          { display_name: "Curator", role: "DATA_CURATOR", affiliation: { name: "Institute A" } },
        ],
      },
    };
    expect(creatorsFromSnapshot(snap, "Institute B").map((c) => c.name)).toEqual(["홍길동", "Co"]);
    expect(creatorsFromSnapshot({}, "Institute B")).toEqual([{ name: "Institute B", affiliation: null, ntis: null, kind: "organization" }]);
  });
  it("lists a PI who is also a co-investigator once", () => {
    const pi = { display_name: "홍길동", affiliation: { name: "Institute B" }, national_researcher_number: "10000002" };
    const snap = { people: { principal_investigator: pi, contributors: [{ ...pi, role: "CO_INVESTIGATOR" }] } };
    expect(creatorsFromSnapshot(snap, "Institute B").map((c) => c.name)).toEqual(["홍길동"]);
  });
  it("escapes every BibTeX special and braces names that contain ' and '", () => {
    const out = renderCitation("bibtex", { ...C, title: "a\\b ~ c^2", creators: [{ name: "Smith and Wesson Lab", affiliation: null, ntis: null }, C.creators[0]!] });
    expect(out).toContain("title = {a\\textbackslash{}b \\textasciitilde{} c\\textasciicircum{}2}");
    expect(out).toContain("author = {{Smith and Wesson Lab} and 홍길동}");
  });
  it("a person without an affiliation is still Personal in DataCite; the organization fallback is Organizational", () => {
    const data = JSON.parse(renderCitation("datacite-json", { ...C, creators: [{ name: "Solo", affiliation: null, ntis: null, kind: "person" }, { name: "Institute B", affiliation: null, ntis: null, kind: "organization" }] }));
    expect(data.creators.map((c: { nameType: string }) => c.nameType)).toEqual(["Personal", "Organizational"]);
  });
});
