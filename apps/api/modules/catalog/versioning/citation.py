"""Dataset version citations (spec §4 getDatasetCitation): text (APA-like), BibTeX, DataCite 4.5 JSON. Pure.

Mirrors the web mock (apps/web/src/mocks/versioning.ts renderCitation / creatorsFromSnapshot). Creators come from the
version's frozen metadata snapshot (D-029): the principal investigator, then co-investigators, so affiliations are
the ones at publication time. The snapshot's people carry no email (Ruling P23) and creators copy only name,
affiliation name and national researcher number."""

import json
import re
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Literal

CREATOR_ROLES = frozenset({"CO_INVESTIGATOR"})  # PI first, then co-investigators (DataCite creators)
STYLES = ("text", "bibtex", "datacite-json")


@dataclass(frozen=True)
class Creator:
    name: str
    affiliation: str | None
    ntis: str | None
    kind: Literal["person", "organization"] = "person"  # organization: the owner-institute fallback


@dataclass(frozen=True)
class CitationInput:
    title: str
    version_label: str
    year: int
    publisher: str
    uri: str
    doi: str | None
    license: str | None
    creators: tuple[Creator, ...]


def _person(p: Mapping[str, Any]) -> Creator:
    affiliation = p.get("affiliation") or {}
    return Creator(str(p["display_name"]), affiliation.get("name"), p.get("national_researcher_number"))


def creators_from_snapshot(snapshot: Mapping[str, Any], fallback_org: str) -> tuple[Creator, ...]:
    people = snapshot.get("people") or {}
    found: list[Creator] = []
    if people.get("principal_investigator"):
        found.append(_person(people["principal_investigator"]))
    found += [_person(c) for c in people.get("contributors") or [] if c.get("role") in CREATOR_ROLES]
    # A PI who is also listed as co-investigator is one creator, not two (first occurrence wins).
    unique = tuple(dict.fromkeys(found))
    return unique or (Creator(fallback_org, None, None, "organization"),)


_BIB_SPECIAL = re.compile(r"[\\{}&%$#_~^]")
_BIB_WORDS = {"\\": "\\textbackslash{}", "~": "\\textasciitilde{}", "^": "\\textasciicircum{}"}
_AND = re.compile(r" and ", re.IGNORECASE)


def bib_escape(value: str) -> str:
    """One pass, so the braces of \\textbackslash{} are never escaped again."""
    return _BIB_SPECIAL.sub(lambda m: _BIB_WORDS.get(m.group(), "\\" + m.group()), value)


def _bib_name(c: Creator) -> str:
    """A name containing " and " (or an organization) is braced, so BibTeX keeps it as one author."""
    escaped = bib_escape(c.name)
    return "{" + escaped + "}" if c.kind == "organization" or _AND.search(c.name) else escaped


def _datacite_creator(x: Creator) -> dict[str, Any]:
    item: dict[str, Any] = {
        "name": x.name,
        "nameType": "Organizational" if x.kind == "organization" else "Personal",
    }
    if x.affiliation:
        item["affiliation"] = [{"name": x.affiliation}]
    if x.ntis:
        item["nameIdentifiers"] = [{"nameIdentifier": x.ntis, "nameIdentifierScheme": "NTIS"}]
    return item


def render(style: str, c: CitationInput) -> str:
    if style == "text":
        names = ", ".join(x.name for x in c.creators)
        link = f"https://doi.org/{c.doi}" if c.doi else c.uri
        return f"{names} ({c.year}). {c.title} (Version {c.version_label}) [Data set]. {c.publisher}. {link}"
    if style == "bibtex":
        key = "nais_" + re.sub(r"[^A-Za-z0-9]", "", c.uri.rsplit("/", 1)[-1])[:32]
        fields = [
            ("author", " and ".join(_bib_name(x) for x in c.creators)),
            ("title", bib_escape(c.title)),
            ("version", bib_escape(c.version_label)),
            ("publisher", bib_escape(c.publisher)),
            ("year", str(c.year)),
            ("url", c.uri),
        ] + ([("doi", c.doi)] if c.doi else [])
        return "@misc{" + key + ",\n" + "".join(f"  {k} = {{{v}}},\n" for k, v in fields) + "}"
    if style == "datacite-json":
        data: dict[str, Any] = {
            "creators": [_datacite_creator(x) for x in c.creators],
            "titles": [{"title": c.title}],
            "publisher": {"name": c.publisher},
            "publicationYear": str(c.year),
            "version": c.version_label,
            "types": {"resourceTypeGeneral": "Dataset"},
            "identifiers": [{"identifier": c.uri, "identifierType": "URL"}]
            + ([{"identifier": c.doi, "identifierType": "DOI"}] if c.doi else []),
            "rightsList": [{"rights": c.license}] if c.license else [],
        }
        # Same bytes as the mock's JSON.stringify(sortKeys(...)): sorted keys at every level, no whitespace.
        return json.dumps(data, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    raise ValueError(style)
