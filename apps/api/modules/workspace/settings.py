"""M13 workspace configuration (env, extra keys ignored)."""

from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class WorkspaceSettings(BaseSettings):
    model_config = SettingsConfigDict(extra="ignore")

    # browser-facing base of presigned storage URLs (the :21051 gateway); same variable the catalog reads
    nais_public_base_url: str = "http://localhost:21051"
    # recipe runs (worker queue `workspace`): rows per input and per result, input file size, wall-clock limit
    workspace_max_rows: int = Field(default=5_000_000, ge=1)
    workspace_max_input_bytes: int = Field(default=1024**3, ge=1)
    workspace_run_timeout_seconds: int = Field(default=1800, ge=1)
    workspace_worker_concurrency: int = Field(default=1, ge=1)


@lru_cache(maxsize=1)
def get_workspace_settings() -> WorkspaceSettings:
    return WorkspaceSettings()
