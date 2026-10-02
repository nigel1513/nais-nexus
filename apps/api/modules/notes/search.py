"""searchNotes: hybrid (semantic + keyword) search over the notes the caller may read.

What is searched: a note version's searchable text = its HUMAN blocks and the AI blocks the recorder accepted, in
order (repo.SEARCHABLE_BLOCK; no section is singled out, so a changed section template needs no change here). An AI
sentence not (yet) accepted is not the researcher's record, so it is neither embedded, matched nor shown in a snippet.

Scope (repo.search_scope): exactly what listNotes lists to the caller: the latest version of each of their own
(project, day) notes in any status, and the SUBMITTED/SIGNED notes whose witness snapshot names them in projects where
they are an ACTIVE member. Another recorder's DRAFT is never a candidate, so its text never reaches a snippet.

Ranking:
1. The query alone is embedded first, before any database statement (no transaction is open during that HTTP call),
   with the short request-path timeout NotesSettings.nais_search_timeout_s (NAIS_SEARCH_TIMEOUT_S).
2. Candidates = the cosine top CANDIDATES (stored vectors are unit length, so cosine is a dot product; the scope's
   vectors are streamed and only the best CANDIDATES kept) united with the keyword top KEYWORD_CANDIDATES (searchable
   blocks containing q, ILIKE literally, newest day first), embedded or not.
3. With the reranker on: every candidate is reranked (an unembedded keyword match gets a real score), top MAX_HITS,
   score = rerank score. The read transaction is committed first, so no connection is held during that call.
   Without a reranker, or when it fails: reciprocal-rank fusion of the cosine rank and the keyword rank
   (RRF_K = 60), score = the fused score.
4. Semantic search unavailable altogether (embedding service off, or the query embedding failed): the keyword top
   MAX_HITS with score null.

Snippet: at most SNIPPET_CHARS of plain text (whitespace collapsed) around the best-matching block: the first block
containing q, else the block with most query words, else the first block.
"""

import hashlib
import heapq
import logging
import math
import re
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date
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
CANDIDATES = 50  # cosine top N
KEYWORD_CANDIDATES = 20  # keyword top N joined to them
RRF_K = 60
SNIPPET_CHARS = 160
RERANK_CHARS = 2000  # per document sent to the reranker
EMBED_CHARS = 6000  # bge-m3 takes 8192 tokens; Korean text runs at most ~1 token per character
_LEAD = 40  # snippet characters kept before the match
_SPACE = re.compile(r"\s+")


# ---------------------------------------------------------------- text


def searchable_text(texts: Sequence[str]) -> str:
    """The text a note is embedded and reranked by (its searchable blocks, one per line)."""
    return "\n".join(t.strip() for t in texts if t.strip())


def text_hash(model: str, text: str) -> str:
    """What a stored vector depends on: the embedding model id and the searchable text."""
    return hashlib.sha256(f"{model}\n{text}".encode()).hexdigest()


def unit(vector: Sequence[float]) -> list[float]:
    norm = math.sqrt(math.sumprod(vector, vector))
    return [x / norm for x in vector] if norm else []


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


@dataclass(frozen=True)
class _Candidate:
    note_id: UUID
    project_id: UUID
    note_date: date


def _embed_query(deps: NotesDeps, q: str, timeout_s: float) -> list[float] | None:
    embedder = deps.embedder(timeout_s=timeout_s)
    if embedder is None:
        return None
    try:
        [vector] = embedder.embed([q])
    except (LlmUnavailable, ValueError) as exc:
        logger.warning(
            "search: query embedding failed, keyword only", extra={"error_type": type(exc).__name__}
        )
        return None
    return unit(vector) or None


def _cosine_top(session: Session, scope: Subquery, query: list[float]) -> list[tuple[float, _Candidate]]:
    """The CANDIDATES best (dot product of unit vectors) of the scope's embedded notes, best first; equal scores
    rank the later note_date first, then by note_id (a stable order whatever order the rows stream in)."""
    scored = (
        (math.sumprod(query, row["vector"]), _Candidate(row["note_id"], row["project_id"], row["note_date"]))
        for row in repo.scope_vectors(session, scope)
        if len(row["vector"]) == len(query)
    )
    return heapq.nsmallest(
        CANDIDATES,
        scored,
        key=lambda pair: (-pair[0], -pair[1].note_date.toordinal(), pair[1].note_id),
    )


def _fused(cosine_ids: list[UUID], keyword_ids: list[UUID]) -> dict[UUID, float]:
    scores: dict[UUID, float] = {}
    for ranking in (cosine_ids, keyword_ids):
        for rank, note_id in enumerate(ranking, start=1):
            scores[note_id] = scores.get(note_id, 0.0) + 1.0 / (RRF_K + rank)
    return scores


def _rank(
    session: Session, deps: NotesDeps, q: str, query: list[float], scope: Subquery, timeout_s: float
) -> tuple[list[tuple[_Candidate, float | None]], dict[UUID, list[str]]]:
    cosine = _cosine_top(session, scope, query)
    keyword = [_Candidate(r["note_id"], r["project_id"], r["note_date"]) for r in _keyword(session, scope, q)]
    candidates: dict[UUID, _Candidate] = {}
    for c in [c for _, c in cosine] + keyword:
        candidates.setdefault(c.note_id, c)
    texts = repo.searchable_blocks(session, list(candidates))
    session.commit()  # read-only so far: release the connection before the rerank call
    reranker = deps.reranker(timeout_s=timeout_s) if candidates else None
    if reranker is not None:
        ordered = list(candidates.values())
        documents = [searchable_text(texts[c.note_id])[:RERANK_CHARS] for c in ordered]
        try:
            scores = reranker.rerank(q, documents)
        except (LlmUnavailable, ValueError) as exc:
            logger.warning("search: rerank failed, fused order", extra={"error_type": type(exc).__name__})
        else:
            if len(scores) == len(ordered):
                reranked = sorted(zip(ordered, scores, strict=True), key=lambda pair: -pair[1])
                return [(c, float(s)) for c, s in reranked[:MAX_HITS]], texts
    fused = _fused([c.note_id for _, c in cosine], [c.note_id for c in keyword])
    order = sorted(candidates.values(), key=lambda c: -fused[c.note_id])  # stable: ties keep cosine order
    return [(c, fused[c.note_id]) for c in order[:MAX_HITS]], texts


def _keyword(session: Session, scope: Subquery, q: str, limit: int = KEYWORD_CANDIDATES) -> list[RowMapping]:
    return repo.keyword_hits(session, scope, q, limit=limit)


def search_notes(
    session: Session, deps: NotesDeps, user: CurrentUser, q: str, project_id: UUID | None
) -> list[NoteSearchHit]:
    timeout_s = deps.settings.nais_search_timeout_s
    query = _embed_query(deps, q, timeout_s)  # before any statement on the session
    scope = repo.search_scope(
        user.user_id,
        witness_project_ids=deps.projects.list_project_ids_for_member(user.user_id),
        project_id=project_id,
    )
    hits: list[tuple[_Candidate, float | None]]
    if query is None:
        rows = _keyword(session, scope, q, MAX_HITS)
        hits = [(_Candidate(r["note_id"], r["project_id"], r["note_date"]), None) for r in rows]
        texts = repo.searchable_blocks(session, [c.note_id for c, _ in hits])
    else:
        hits, texts = _rank(session, deps, q, query, scope, timeout_s)
    names: dict[UUID, str] = {}
    out = []
    for c, score in hits:
        if c.project_id not in names:
            summary = deps.projects.get_summary(c.project_id)
            names[c.project_id] = summary.name if summary is not None else ""
        out.append(
            NoteSearchHit.model_validate(
                {
                    "note_id": c.note_id,
                    "project_name": names[c.project_id],
                    "note_date": c.note_date,
                    "snippet": snippet(texts.get(c.note_id, []), q),
                    "score": score,
                }
            )
        )
    return out
