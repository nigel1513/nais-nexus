"""searchNotes: semantic search over the notes the caller may read, with a keyword fallback.

What is searched: a note version's searchable text = its HUMAN blocks and the AI blocks the recorder accepted, in
order (repo.SEARCHABLE_BLOCK). An AI sentence not (yet) accepted is not the researcher's record, so it is neither
embedded, matched nor shown in a snippet.

Scope (repo.search_scope): exactly what listNotes lists to the caller: the latest version of each of their own
(project, day) notes in any status, and the SUBMITTED/SIGNED notes whose witness snapshot names them in projects where
they are an ACTIVE member. Another recorder's DRAFT is never a candidate, so its text never reaches a snippet.

Ranking:
1. Semantic (embedding service on): the query alone is embedded on the request path (bge-m3); cosine against the
   stored vectors of the scope (jobs.embed_notes computes them in the worker), top CANDIDATES; with the reranker on
   they are reranked and the top MAX_HITS kept (score = rerank score), else the cosine top MAX_HITS (score = cosine).
   A failing reranker keeps the cosine order; a failing query embedding means no semantic hits.
2. Keyword (always, to fill up to MAX_HITS): searchable blocks containing q (ILIKE, literal), newest day first,
   score null, notes already among the semantic hits left out. With the service off this is the whole answer; with it
   on it brings in notes not embedded yet.

Snippet: at most SNIPPET_CHARS of plain text (whitespace collapsed) around the best-matching block: the first block
containing q, else the block with most query words, else the first block.
"""

import hashlib
import logging
import math
import re
from collections.abc import Sequence
from uuid import UUID

from nais_contracts.api_models import NoteSearchHit
from sqlalchemy import Subquery
from sqlalchemy.engine import RowMapping
from sqlalchemy.orm import Session

from api.modules.notes import repo
from api.modules.notes.deps import NotesDeps
from api.platform.auth import CurrentUser
from api.platform.llm import LlmUnavailable

logger = logging.getLogger("nais.notes")

MAX_HITS = 20  # openapi searchNotes items maxItems
CANDIDATES = 50  # cosine top N handed to the reranker
SNIPPET_CHARS = 160
RERANK_CHARS = 2000  # per document sent to the reranker
EMBED_CHARS = 6000  # bge-m3 takes 8192 tokens; Korean text runs at most ~1 token per character
_LEAD = 40  # snippet characters kept before the match
_SPACE = re.compile(r"\s+")


# ---------------------------------------------------------------- text


def searchable_text(texts: Sequence[str]) -> str:
    """The text a note is embedded and reranked by (its searchable blocks, one per line)."""
    return "\n".join(t.strip() for t in texts if t.strip())


def text_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _plain(text: str) -> str:
    return _SPACE.sub(" ", text).strip()


def snippet(texts: Sequence[str], q: str) -> str:
    blocks = [p for p in (_plain(t) for t in texts) if p]
    if not blocks:
        return ""
    needle = _plain(q).lower()
    words = [w for w in needle.split(" ") if w]
    best, at = blocks[0], -1
    for block in blocks:
        if needle and needle in block.lower():
            best, at = block, block.lower().index(needle)
            break
    else:
        counts = [sum(block.lower().count(w) for w in words) for block in blocks]
        if max(counts, default=0) > 0:
            best = blocks[counts.index(max(counts))]
            lowered = best.lower()
            at = min((lowered.index(w) for w in words if w in lowered), default=-1)
    if len(best) <= SNIPPET_CHARS:
        return best
    start = max(0, min(at - _LEAD, len(best) - SNIPPET_CHARS)) if at >= 0 else 0
    head = "…" if start > 0 else ""
    room = SNIPPET_CHARS - len(head)
    body = best[start : start + room]
    if start + room < len(best):
        body = body[: room - 1] + "…"
    return head + body


# ---------------------------------------------------------------- ranking


def cosine(a: Sequence[float], b: Sequence[float]) -> float:
    norm = math.sqrt(math.sumprod(a, a)) * math.sqrt(math.sumprod(b, b))
    return math.sumprod(a, b) / norm if norm else 0.0


def _semantic(
    session: Session, deps: NotesDeps, q: str, scope: Subquery, texts: dict[UUID, list[str]]
) -> list[tuple[RowMapping, float]]:
    embedder = deps.embedder()
    if embedder is None:
        return []
    rows = repo.scope_vectors(session, scope)
    if not rows:
        return []
    try:
        [query] = embedder.embed([q])
    except (LlmUnavailable, ValueError) as exc:
        logger.warning(
            "search: query embedding failed, keyword only", extra={"error_type": type(exc).__name__}
        )
        return []
    scored = [(row, cosine(query, row["vector"])) for row in rows if len(row["vector"]) == len(query)]
    scored.sort(key=lambda pair: (-pair[1], -pair[0]["note_date"].toordinal(), str(pair[0]["note_id"])))
    top = scored[:CANDIDATES]
    reranker = deps.reranker()
    if reranker is None or not top:
        return top[:MAX_HITS]
    texts.update(repo.searchable_blocks(session, [row["note_id"] for row, _ in top]))
    documents = [searchable_text(texts[row["note_id"]])[:RERANK_CHARS] for row, _ in top]
    try:
        scores = reranker.rerank(q, documents)
    except (LlmUnavailable, ValueError) as exc:
        logger.warning("search: rerank failed, cosine order", extra={"error_type": type(exc).__name__})
        return top[:MAX_HITS]
    if len(scores) != len(top):
        return top[:MAX_HITS]
    reranked = [(row, score) for (row, _), score in zip(top, scores, strict=True)]
    reranked.sort(key=lambda pair: -pair[1])  # stable: ties keep the cosine order
    return reranked[:MAX_HITS]


def search_notes(
    session: Session, deps: NotesDeps, user: CurrentUser, q: str, project_id: UUID | None
) -> list[NoteSearchHit]:
    scope = repo.search_scope(
        user.user_id,
        witness_project_ids=deps.projects.list_project_ids_for_member(user.user_id),
        project_id=project_id,
    )
    texts: dict[UUID, list[str]] = {}
    hits: list[tuple[RowMapping, float | None]] = list(_semantic(session, deps, q, scope, texts))
    if len(hits) < MAX_HITS:
        seen = {row["note_id"] for row, _ in hits}
        for row in repo.keyword_hits(session, scope, q, limit=MAX_HITS + len(hits)):
            if row["note_id"] not in seen and len(hits) < MAX_HITS:
                hits.append((row, None))
    missing = [row["note_id"] for row, _ in hits if row["note_id"] not in texts]
    texts.update(repo.searchable_blocks(session, missing))
    names: dict[UUID, str] = {}
    out = []
    for row, score in hits:
        project = row["project_id"]
        if project not in names:
            summary = deps.projects.get_summary(project)
            names[project] = summary.name if summary is not None else ""
        out.append(
            NoteSearchHit.model_validate(
                {
                    "note_id": row["note_id"],
                    "project_name": names[project],
                    "note_date": row["note_date"],
                    "snippet": snippet(texts[row["note_id"]], q),
                    "score": score,
                }
            )
        )
    return out
