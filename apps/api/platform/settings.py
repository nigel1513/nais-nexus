from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

REPO_ROOT = Path(__file__).resolve().parents[3]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(extra="ignore")

    nais_public_base_url: str = "http://localhost:21051"
    database_url: str = "postgresql+psycopg://nais_app:nais_app@localhost:21055/nais"
    migration_database_url: str = "postgresql+psycopg://nais_migrator:nais_migrator@localhost:21055/nais"
    redis_url: str = "redis://localhost:21058/0"
    opensearch_url: str = "http://localhost:21056"
    opa_url: str = "http://localhost:21057"
    opa_timeout_ms: int = 500
    oidc_issuer: str = "http://localhost:21051/auth/realms/nais"
    oidc_internal_jwks_url: str = "http://localhost:21051/auth/realms/nais/protocol/openid-connect/certs"
    oidc_audience: str = "nais-api"
    oidc_clock_skew_seconds: int = 30
    contracts_dir: Path = REPO_ROOT / "NAIS_PRD" / "contracts"
    log_level: str = "INFO"
    otel_exporter_otlp_endpoint: str | None = None
    otel_service_name: str = "nais-api"
    outbox_batch_size: int = 100
    outbox_max_attempts: int = 10
    worker_threads: int = 4
    storage_org_codes: str = "nais,inst-a,inst-b"
    health_check_timeout_seconds: float = 2.0

    @property
    def storage_org_code_list(self) -> list[str]:
        return [code.strip() for code in self.storage_org_codes.split(",") if code.strip()]


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
