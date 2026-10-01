"""M02 §11 configuration."""

from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class ProjectSettings(BaseSettings):
    model_config = SettingsConfigDict(extra="ignore")

    project_max_members: int = Field(default=200, ge=1)  # env PROJECT_MAX_MEMBERS


@lru_cache(maxsize=1)
def get_project_settings() -> ProjectSettings:
    return ProjectSettings()
