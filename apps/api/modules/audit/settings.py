"""M09 env vars (spec §11). Platform Settings ignores unknown keys, so the module reads its own."""

from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class AuditSettings(BaseSettings):
    model_config = SettingsConfigDict(extra="ignore")

    smtp_host: str = "mailpit"
    smtp_port: int = 1025
    smtp_from: str = "NAIS AI-OS <no-reply@nais.local>"
    smtp_timeout_seconds: float = 10.0
    notification_email_enabled: bool = True
    notification_retention_days: int = 180
    nais_public_base_url: str = "http://localhost:21051"
    allow_fake_ports: bool = Field(default=False, validation_alias="AUDIT_ALLOW_FAKE_PORTS")


@lru_cache(maxsize=1)
def get_audit_settings() -> AuditSettings:
    return AuditSettings()
