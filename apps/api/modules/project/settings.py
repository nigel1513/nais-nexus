"""M02 §11 configuration."""

from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class ProjectSettings(BaseSettings):
    model_config = SettingsConfigDict(extra="ignore")

    project_max_members: int = Field(default=200, ge=1)  # env PROJECT_MAX_MEMBERS
    # Public project search (search.py). Without OPENSEARCH_URL in the environment there is no project index and
    # scope=discover searches by name in the database.
    opensearch_url: str | None = None
    project_index_alias: str = "nais-projects"
    # Demo projects of the mock-mode web server (internal.py): their own index, never the real one.
    project_demo_index_alias: str = "nais-demo-projects"
    nais_internal_token: str = ""  # D-049: empty -> the internal endpoints do not exist
    project_opensearch_timeout_seconds: float = Field(default=5.0, gt=0)
    project_embed_query_timeout_seconds: float = Field(default=2.0, gt=0)
    project_semantic_min_score: float = Field(default=0.76, ge=0.5, le=1.0)


@lru_cache(maxsize=1)
def get_project_settings() -> ProjectSettings:
    return ProjectSettings()
