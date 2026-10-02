"""M14 research-notes configuration (env, extra keys ignored)."""

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class NotesSettings(BaseSettings):
    model_config = SettingsConfigDict(extra="ignore")

    # NAIS_LLM_ENABLED, the platform's switch for the local LLM (also read by api.platform.settings); getNoteSettings
    # mirrors it as llm_enabled so the web hides the draft button.
    nais_llm_enabled: bool = False


@lru_cache(maxsize=1)
def get_notes_settings() -> NotesSettings:
    return NotesSettings()
