"""Operational knobs only (M05 §11). Anything that changes a verdict is a profile parameter, never env."""

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class ReadinessSettings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="READINESS_", extra="ignore")

    run_timeout_seconds: int = 1800
    file_timeout_seconds: int = 600
    worker_concurrency: int = 2


@lru_cache(maxsize=1)
def get_readiness_settings() -> ReadinessSettings:
    return ReadinessSettings()
