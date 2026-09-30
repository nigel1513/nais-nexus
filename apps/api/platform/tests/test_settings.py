import pytest

from api.platform.settings import Settings


def test_defaults_point_at_the_21051_gateway(monkeypatch: pytest.MonkeyPatch) -> None:
    for key in ("NAIS_PUBLIC_BASE_URL", "OIDC_ISSUER", "REDIS_URL"):
        monkeypatch.delenv(key, raising=False)
    settings = Settings()
    assert settings.nais_public_base_url == "http://localhost:21051"
    assert settings.oidc_issuer == "http://localhost:21051/auth/realms/nais"
    assert settings.redis_url == "redis://nais:nais@localhost:21058/0"


def test_environment_overrides_defaults(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DATABASE_URL", "postgresql+psycopg://u:p@db:5432/nais")
    assert Settings().database_url == "postgresql+psycopg://u:p@db:5432/nais"


def test_contracts_dir_contains_the_contracts() -> None:
    assert (Settings().contracts_dir / "openapi.yaml").is_file()


def test_storage_org_codes_are_split(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("STORAGE_ORG_CODES", " nais, inst-a ,inst-b,")
    assert Settings().storage_org_code_list == ["nais", "inst-a", "inst-b"]
