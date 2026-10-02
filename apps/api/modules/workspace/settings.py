"""M13 workspace configuration (env, extra keys ignored). Later tasks add recipe/run limits here."""

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class WorkspaceSettings(BaseSettings):
    model_config = SettingsConfigDict(extra="ignore")


@lru_cache(maxsize=1)
def get_workspace_settings() -> WorkspaceSettings:
    return WorkspaceSettings()
