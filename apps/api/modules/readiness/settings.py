"""Operational knobs only (M05 §11). Anything that changes a verdict is a profile parameter, never env."""

from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class ReadinessSettings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="READINESS_", extra="ignore")

    run_timeout_seconds: int = Field(default=1800, ge=1)
    file_timeout_seconds: int = Field(default=600, ge=1)
    worker_concurrency: int = Field(default=2, ge=1)


@lru_cache(maxsize=1)
def get_readiness_settings() -> ReadinessSettings:
    return ReadinessSettings()
