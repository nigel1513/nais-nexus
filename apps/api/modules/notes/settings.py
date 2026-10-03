"""M14 research-notes configuration (env, extra keys ignored)."""

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class NotesSettings(BaseSettings):
    model_config = SettingsConfigDict(extra="ignore")

    # The local LLM switch (NAIS_LLM_*) is the platform's (api.platform.settings / api.platform.llm); notes read it
    # through NotesDeps.llm, and getNoteSettings.llm_enabled mirrors it.

    # searchNotes waits at most this long for the query embedding and for the rerank (each), then falls back.
    nais_search_timeout_s: float = 5.0

    # The web server's shared secret for /internal/notes/* (header X-NAIS-Internal-Token, D-049). Empty = those
    # endpoints answer 404.
    nais_internal_token: str = ""


@lru_cache(maxsize=1)
def get_notes_settings() -> NotesSettings:
    return NotesSettings()
