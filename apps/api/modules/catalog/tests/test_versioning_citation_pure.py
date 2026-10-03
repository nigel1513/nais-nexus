"""Version citations (spec §4 getDatasetCitation): text, BibTeX, DataCite 4.5 JSON. Pure; mirrors the web mock."""

import json
from dataclasses import replace

import pytest

from api.modules.catalog.versioning.citation import (
    CitationInput,
    Creator,
    bib_escape,
    creators_from_snapshot,
    render,
)

C = CitationInput(
    title="Battery Cycling Measurements",
    version_label="v2.0",
    year=2026,
    publisher="Institute B",
    uri="http://localhost:21051/id/dataset-version/abc",
    doi=None,
    license="CC-BY-4.0",
    creators=(Creator("홍길동", "Institute B", "10000002"), Creator("B Researcher", "Institute A", None)),
)
ORG = Creator("Institute B", None, None, "organization")


def test_text_style() -> None:
    assert render("text", C) == (
        "홍길동, B Researcher (2026). Battery Cycling Measurements (Version v2.0) [Data set]. Institute B. "
        "http://localhost:21051/id/dataset-version/abc"
    )


def test_text_style_prefers_the_doi() -> None:
    assert render("text", replace(C, doi="10.1234/x")).endswith(". Institute B. https://doi.org/10.1234/x")


def test_bibtex_style_escapes_and_keys() -> None:
    out = render("bibtex", C)
    assert out.startswith("@misc{nais_abc,\n")
    assert "  author = {홍길동 and B Researcher},\n" in out
    assert "  version = {v2.0},\n" in out and "  year = {2026},\n" in out
    assert "  url = {http://localhost:21051/id/dataset-version/abc},\n" in out and out.endswith("}")
    assert "doi" not in out
    assert render("bibtex", replace(C, title="A {b} & c")).count("\\{b\\}") == 1
    assert "  doi = {10.1234/x},\n" in render("bibtex", replace(C, doi="10.1234/x"))


@pytest.mark.parametrize(
    ("raw", "escaped"),
    [
        ("plain", "plain"),
        ("{", "\\{"),
        ("}", "\\}"),
        ("&", "\\&"),
        ("%", "\\%"),
        ("$", "\\$"),
        ("#", "\\#"),
        ("_", "\\_"),
        ("\\", "\\textbackslash{}"),
        ("~", "\\textasciitilde{}"),
        ("^", "\\textasciicircum{}"),
        ("a\\{b}", "a\\textbackslash{}\\{b\\}"),  # the backslash is not escaped twice
        (
            "50% of $x_1 ~ y^2 #3 & {z}",
            "50\\% of \\$x\\_1 \\textasciitilde{} y\\textasciicircum{}2 \\#3 \\& \\{z\\}",
        ),
    ],
)
def test_bibtex_escaping_table(raw: str, escaped: str) -> None:
    assert bib_escape(raw) == escaped


def test_bibtex_braces_names_with_and_and_organizations() -> None:
    c = replace(
        C, creators=(Creator("Smith and Wesson", None, None), Creator("Lab_1", None, None, "organization"))
    )
    assert "  author = {{Smith and Wesson} and {Lab\\_1}},\n" in render("bibtex", c)
    c = replace(C, creators=(Creator("Ann AND Bo", "X", None), Creator("Andersen", "X", None)))
    assert "  author = {{Ann AND Bo} and Andersen},\n" in render("bibtex", c)


def test_datacite_json() -> None:
    data = json.loads(render("datacite-json", C))
    assert data["types"] == {"resourceType": "Dataset", "resourceTypeGeneral": "Dataset"}
    assert data["creators"][0] == {
        "name": "홍길동",
        "nameType": "Personal",
        "affiliation": [{"name": "Institute B"}],
        "nameIdentifiers": [{"nameIdentifier": "10000002", "nameIdentifierScheme": "NTIS"}],
    }
    assert "nameIdentifiers" not in data["creators"][1]
    assert data["identifiers"] == [{"identifier": C.uri, "identifierType": "URL"}]
    assert data["version"] == "v2.0" and data["publicationYear"] == "2026"
    assert data["rightsList"] == [{"rights": "CC-BY-4.0"}]
    assert data["titles"] == [{"title": C.title}] and data["publisher"] == {"name": "Institute B"}
    assert list(data) == sorted(data)  # stable key order (the mock sorts keys too)
    out = render("datacite-json", C)
    assert out == json.dumps(
        data, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    )  # compact, like JS
    assert out.startswith('{"creators":[{"affiliation":[{"name":"Institute B"}],"name":"홍길동",')


def test_datacite_name_types_and_doi() -> None:
    c = replace(C, doi="10.1234/x", license=None, creators=(Creator("No Affiliation", None, None), ORG))
    data = json.loads(render("datacite-json", c))
    assert data["creators"] == [
        {"name": "No Affiliation", "nameType": "Personal"},  # a person stays Personal without affiliation
        {"name": "Institute B", "nameType": "Organizational"},
    ]
    assert data["identifiers"][1] == {"identifier": "10.1234/x", "identifierType": "DOI"}
    assert data["rightsList"] == []


def test_unknown_style_is_rejected() -> None:
    with pytest.raises(ValueError, match="apa"):
        render("apa", C)


def _p(name: str, org: str | None, ntis: str | None = None, role: str | None = None) -> dict[str, object]:
    out: dict[str, object] = {
        "display_name": name,
        "affiliation": {"name": org} if org else None,
        "national_researcher_number": ntis,
        "user_id": "u-" + name,
    }
    if role:
        out["role"] = role
    return out


def test_creators_from_snapshot_and_fallback() -> None:
    snap = {
        "people": {
            "principal_investigator": _p("홍길동", "Institute B", "10000002"),
            "contributors": [
                _p("Co", "Institute A", role="CO_INVESTIGATOR"),
                _p("Curator", "Institute A", role="DATA_CURATOR"),
            ],
        }
    }
    assert [c.name for c in creators_from_snapshot(snap, "Institute B")] == ["홍길동", "Co"]
    assert creators_from_snapshot({}, "Institute B") == (ORG,)
    assert creators_from_snapshot({"people": None}, "Institute B") == (ORG,)


def test_pi_listed_as_co_investigator_is_one_creator() -> None:
    pi = _p("홍길동", "Institute B", "10000002")
    snap = {"people": {"principal_investigator": pi, "contributors": [{**pi, "role": "CO_INVESTIGATOR"}]}}
    assert creators_from_snapshot(snap, "X") == (Creator("홍길동", "Institute B", "10000002"),)


def test_affiliation_is_the_snapshot_one_and_no_email_leaks() -> None:
    pi = {
        **_p("홍길동", "Institute A (then)", "10000002"),
        "current_organization": {"name": "Institute C (now)"},
        "email": "private@example.org",
    }
    [creator] = creators_from_snapshot({"people": {"principal_investigator": pi}}, "X")
    assert creator.affiliation == "Institute A (then)"
    c = replace(C, creators=(creator,))
    for style in ("text", "bibtex", "datacite-json"):
        out = render(style, c)
        assert "private@example.org" not in out and "Institute C" not in out
