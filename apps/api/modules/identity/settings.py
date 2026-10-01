"""Identity configuration. Env names are the field names upper-cased."""

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class IdentitySettings(BaseSettings):
    model_config = SettingsConfigDict(extra="ignore")

    keycloak_admin_url: str = "http://localhost:21051/auth"
    keycloak_admin_user: str = "nais"
    keycloak_admin_password: str = "nais"
    keycloak_realm: str = "nais"


@lru_cache(maxsize=1)
def get_identity_settings() -> IdentitySettings:
    return IdentitySettings()
