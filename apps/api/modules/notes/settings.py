"""M14 research-notes configuration (env, extra keys ignored)."""

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class NotesSettings(BaseSettings):
    model_config = SettingsConfigDict(extra="ignore")

    # No module keys yet. The local LLM switch (NAIS_LLM_*) is the platform's (api.platform.settings /
    # api.platform.llm); notes read it through NotesDeps.llm, and getNoteSettings.llm_enabled mirrors it.


@lru_cache(maxsize=1)
def get_notes_settings() -> NotesSettings:
    return NotesSettings()
