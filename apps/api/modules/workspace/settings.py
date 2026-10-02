"""M13 workspace configuration (env, extra keys ignored). Later tasks add recipe/run limits here."""

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class WorkspaceSettings(BaseSettings):
    model_config = SettingsConfigDict(extra="ignore")

    # browser-facing base of presigned storage URLs (the :21051 gateway); same variable the catalog reads
    nais_public_base_url: str = "http://localhost:21051"


@lru_cache(maxsize=1)
def get_workspace_settings() -> WorkspaceSettings:
    return WorkspaceSettings()
