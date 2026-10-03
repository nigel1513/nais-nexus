"""Public project search (discovery §1.1): OpenSearch alias nais-projects.

Only what every signed-in user may already see goes into the index: PUBLIC + ACTIVE projects, and of those the
discover-list fields (name, lead organization, member count, updated). A project's description, keywords, members
and inputs are member-only and stay in the database; PRIVATE and ARCHIVED projects are not indexed at all.

The index is reconciled, not queued: every few seconds the worker compares the public projects in the database with
the indexed documents and writes the difference (a new, renamed, re-opened, archived or un-published project). The
public set is small, so the comparison is one SQL query and one search.
"""

import logging
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from api.modules.project import repository as repo
from api.modules.project.identity import IdentityQueryPort
from api.modules.project.tables import projects
from api.platform.llm import EmbeddingClient
from api.platform.search_index import EMBEDDING_FIELD, OpenSearchIndex, embedding_text

logger = logging.getLogger("nais.project.search")

INDEX_VERSION = 1
SYNC_INTERVAL_S = 5.0
MAX_PUBLIC_PROJECTS = 10_000
SEMANTIC_BOOST = 4.0
SEARCH_FIELDS = ["name^3", "lead_organization_name.text"]


def _text() -> dict[str, Any]:
    return {"type": "text", "analyzer": "ko_en"}


MAPPINGS: dict[str, Any] = {
    "dynamic": "strict",
    "properties": {
        "project_id": {"type": "keyword"},
        "name": {**_text(), "fields": {"raw": {"type": "keyword", "normalizer": "lc"}}},
        "lead_organization_id": {"type": "keyword"},
        "lead_organization_name": {"type": "keyword", "fields": {"text": _text()}},
        "member_count": {"type": "integer"},
        "updated_at": {"type": "date"},
        # What the document was built from; the reconciler rewrites a document whose key differs.
        "sync_key": {"type": "keyword", "index": False},
    },
}


@dataclass(frozen=True)
class ProjectSearch:
    index: OpenSearchIndex
    # Semantic half of the hybrid search (bge-m3). None: lexical only.
    embedder: EmbeddingClient | None = None  # worker: documents
    query_embedder: EmbeddingClient | None = None  # request path: the search text, short timeout
    semantic_min_score: float = 0.76


def project_index(base_url: str, alias: str, *, timeout: float = 5.0) -> OpenSearchIndex:
    return OpenSearchIndex(
        base_url, alias, mappings=MAPPINGS, id_field="project_id", version=INDEX_VERSION, timeout=timeout
    )


def public_documents(session: Session, identity: IdentityQueryPort) -> list[dict[str, Any]]:
    rows = (
        session.execute(
            select(projects)
            .where(projects.c.visibility == "PUBLIC", projects.c.status == "ACTIVE")
            .order_by(projects.c.project_id)
            .limit(MAX_PUBLIC_PROJECTS)
        )
        .mappings()
        .all()
    )
    counts = repo.member_counts(session, [row["project_id"] for row in rows])
    names: dict[UUID, str] = {}
    docs = []
    for row in rows:
        lead = row["lead_organization_id"]
        if lead not in names:
            summary = identity.get_organization_summary(lead)
            names[lead] = summary.name if summary is not None else ""
        members = counts.get(row["project_id"], 0)
        docs.append(
            {
                "project_id": str(row["project_id"]),
                "name": row["name"],
                "lead_organization_id": str(lead),
                "lead_organization_name": names[lead],
                "member_count": members,
                "updated_at": row["updated_at"].isoformat(),
                "sync_key": f"{row['updated_at'].isoformat()}|{members}|{names[lead]}",
            }
        )
    return docs


def _indexed_keys(index: OpenSearchIndex) -> dict[str, str]:
    body = {"query": {"match_all": {}}, "size": MAX_PUBLIC_PROJECTS, "_source": ["sync_key"]}
    return {
        str(hit["_id"]): str(hit["_source"].get("sync_key", "")) for hit in index.search(body)["hits"]["hits"]
    }


def _embed(search: ProjectSearch, docs: list[dict[str, Any]]) -> None:
    """Adds `embedding` (name + lead organization). Without the embedding server the documents go in lexical only
    and their key says so, which makes the next reconciliation try again."""
    if not docs or search.embedder is None or not search.index.supports_vectors():
        return
    try:
        vectors = search.embedder.embed(
            [embedding_text(doc["name"], doc["lead_organization_name"]) for doc in docs]
        )
    except Exception as exc:
        logger.warning("project embedding failed; indexing lexical only", extra={"error": str(exc)[:300]})
        for doc in docs:
            doc["sync_key"] += "|lexical"
        return
    for doc, vector in zip(docs, vectors, strict=True):
        doc[EMBEDDING_FIELD] = vector


def reconcile(search: ProjectSearch, session: Session, identity: IdentityQueryPort) -> tuple[int, int]:
    """Makes the index equal to the public projects in the database. Returns (written, removed)."""
    docs = public_documents(session, identity)
    indexed = _indexed_keys(search.index)
    changed = [doc for doc in docs if indexed.get(doc["project_id"]) != doc["sync_key"]]
    wanted = {doc["project_id"] for doc in docs}
    removed = [project_id for project_id in indexed if project_id not in wanted]
    if not changed and not removed:
        return 0, 0
    _embed(search, changed)
    search.index.bulk(changed, removed)
    search.index.refresh()
    return len(changed), len(removed)


def search_public_project_ids(search: ProjectSearch, q: str, *, limit: int) -> list[UUID]:
    """Ids of the public projects that match `q` by words (BM25) or by meaning (k-NN), best first."""
    lexical: dict[str, Any] = {"multi_match": {"query": q, "fields": SEARCH_FIELDS}}
    query = lexical
    if search.query_embedder is not None:
        try:
            if search.index.supports_vectors():
                vector = search.query_embedder.embed([embedding_text(q)])[0]
                semantic = {
                    "knn": {
                        EMBEDDING_FIELD: {
                            "vector": vector,
                            "min_score": search.semantic_min_score,
                            "boost": SEMANTIC_BOOST,
                        }
                    }
                }
                query = {"bool": {"should": [lexical, semantic], "minimum_should_match": 1}}
        except Exception as exc:
            logger.warning(
                "query embedding unavailable; lexical search only", extra={"error": str(exc)[:300]}
            )
    body = {
        "query": query,
        "size": limit,
        "sort": [{"_score": "desc"}, {"updated_at": "desc"}, {"project_id": "asc"}],
        "_source": False,
    }
    return [UUID(str(hit["_id"])) for hit in search.index.search(body)["hits"]["hits"]]


def reconcile_job(
    search: ProjectSearch, session_factory: Callable[[], Session], identity: Callable[[], IdentityQueryPort]
) -> Callable[[], None]:
    def run() -> None:
        try:
            with session_factory() as session:
                written, removed = reconcile(search, session, identity())
            if written or removed:
                logger.info("project index reconciled", extra={"written": written, "removed": removed})
        except Exception:
            logger.exception("project index reconciliation failed; will retry")

    return run


DEMO_FIELDS = (
    "project_id",
    "name",
    "lead_organization_id",
    "lead_organization_name",
    "member_count",
    "updated_at",
)


def replace_documents(search: ProjectSearch, documents: list[dict[str, Any]]) -> tuple[int, int]:
    """Makes the index equal to `documents` (the public summary fields). Used for the demo index only: the real
    one is reconciled from the database. Returns (written, removed)."""
    docs = [{field: doc.get(field) for field in DEMO_FIELDS} | {"sync_key": "demo"} for doc in documents]
    wanted = {str(doc["project_id"]) for doc in docs}
    removed = sorted(set(search.index.document_ids()) - wanted)
    _embed(search, docs)
    search.index.bulk(docs, removed)
    search.index.refresh()
    return len(docs), len(removed)
