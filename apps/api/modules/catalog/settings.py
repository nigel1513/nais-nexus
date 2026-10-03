"""Catalog configuration (M03 §11). Env names are the field names upper-cased."""

from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

MIB = 1024 * 1024


class CatalogSettings(BaseSettings):
    model_config = SettingsConfigDict(extra="ignore")

    nais_public_base_url: str = "http://localhost:21051"
    opensearch_url: str = "http://nais:nais@localhost:21056"
    catalog_index_alias: str = "nais-datasets"
    # Demo catalogue of the mock-mode web server (routes/internal_demo.py): its own index, never the real one.
    catalog_demo_index_alias: str = "nais-demo-datasets"
    nais_internal_token: str = ""  # D-049: empty -> the internal endpoints do not exist
    storage_org_codes: str = "nais,inst-a,inst-b"
    storage_presign_ttl_seconds: int = Field(300, gt=0)
    upload_url_ttl_seconds: int = Field(3600, gt=0)
    upload_session_ttl_seconds: int = Field(3600, gt=0)
    storage_multipart_threshold_bytes: int = Field(64 * MIB, gt=0)
    catalog_multipart_part_size_bytes: int = Field(64 * MIB, gt=0)
    catalog_sync_verify_max_bytes: int = Field(256 * MIB, gt=0)
    malware_scanner: str = "noop"
    catalog_index_batch_size: int = Field(200, gt=0)
    catalog_opensearch_timeout_seconds: float = Field(5.0, gt=0)
    # Hybrid search: how long a search waits for the query embedding before it falls back to lexical only, and the
    # k-NN score (cosine: (1 + cos) / 2) a document needs to count as a semantic match.
    catalog_embed_query_timeout_seconds: float = Field(2.0, gt=0)
    catalog_semantic_min_score: float = Field(0.76, ge=0.5, le=1.0)
    catalog_preview_max_rows: int = Field(10_000, gt=0)
    catalog_preview_max_bytes: int = Field(64 * MIB, gt=0)
    catalog_preview_timeout_seconds: float = Field(30.0, gt=0)
    catalog_preview_lease_seconds: int = Field(600, gt=0)
    # RLIMIT_AS of the profiling child process (controller ruling P24)
    catalog_preview_memory_limit_bytes: int = Field(1536 * MIB, ge=256 * MIB)

    @property
    def storage_org_code_list(self) -> list[str]:
        return [code.strip() for code in self.storage_org_codes.split(",") if code.strip()]


@lru_cache(maxsize=1)
def get_catalog_settings() -> CatalogSettings:
    return CatalogSettings()
