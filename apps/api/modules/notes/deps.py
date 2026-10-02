"""Everything the notes module talks to, in one container registered in api.platform.ports by wiring.install()."""

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Annotated

from fastapi import Depends

from api.modules.notes.interfaces import DisplayNameLookup
from api.modules.notes.settings import NotesSettings
from api.modules.project.public import ProjectQueryPort
from api.platform import ports
from api.platform.errors import ApiError
from api.platform.generated.error_codes import ErrorCode
from api.platform.llm import (
    EmbeddingClient,
    LlmClient,
    RerankClient,
    get_embedding_client,
    get_llm_client,
    get_rerank_client,
)


@dataclass(frozen=True)
class NotesDeps:
    settings: NotesSettings
    people: DisplayNameLookup
    # The platform LLM client, resolved per use (None while NAIS_LLM_ENABLED is false or no base URL is set).
    llm: Callable[[], LlmClient | None] = field(default=get_llm_client)
    # searchNotes (bge-m3 embeddings, bge-reranker), resolved per use; None while switched off or unconfigured.
    embedder: Callable[[], EmbeddingClient | None] = field(default=get_embedding_client)
    reranker: Callable[[], RerankClient | None] = field(default=get_rerank_client)

    @property
    def projects(self) -> ProjectQueryPort:
        """M02 port, resolved per call (module wiring order does not matter); unwired -> 503."""
        try:
            return ports.get(ProjectQueryPort)
        except ports.PortNotProvided as exc:
            raise ApiError(ErrorCode.DEPENDENCY_UNAVAILABLE, "Project module is not wired.") from exc


def get_deps() -> NotesDeps:
    try:
        return ports.get(NotesDeps)
    except ports.PortNotProvided as exc:
        raise ApiError(ErrorCode.DEPENDENCY_UNAVAILABLE, "Notes module is not wired.") from exc


NotesDepsDep = Annotated[NotesDeps, Depends(get_deps)]
