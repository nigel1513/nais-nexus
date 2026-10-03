"""W1-D4: .env.example lists every Wave 1 module env key with the module's code default."""

import tomllib

from api.platform.settings import REPO_ROOT

MODULE_KEYS = {
    # M02 project
    "PROJECT_MAX_MEMBERS": "200",
    # M03 catalog
    "UPLOAD_URL_TTL_SECONDS": "3600",
    "UPLOAD_SESSION_TTL_SECONDS": "3600",
    "CATALOG_SYNC_VERIFY_MAX_BYTES": "268435456",
    "CATALOG_INDEX_ALIAS": "nais-datasets",
    "MALWARE_SCANNER": "noop",
    # M05 readiness
    "READINESS_RUN_TIMEOUT_SECONDS": "1800",
    "READINESS_FILE_TIMEOUT_SECONDS": "600",
    "READINESS_WORKER_CONCURRENCY": "2",
    # M13 workspace
    "WORKSPACE_MAX_ROWS": "5000000",
    "WORKSPACE_MAX_INPUT_BYTES": "1073741824",
    "WORKSPACE_RUN_TIMEOUT_SECONDS": "1800",
    "WORKSPACE_WORKER_CONCURRENCY": "1",
    # M14 notes
    "NAIS_SEARCH_TIMEOUT_S": "5",
    "NAIS_INTERNAL_TOKEN": "",
    # M09 audit / notification
    "SMTP_FROM": '"NAIS AI-OS <no-reply@nais.local>"',
    "NOTIFICATION_EMAIL_ENABLED": "true",
    "NOTIFICATION_RETENTION_DAYS": "180",
    # M10 web
    "AUTH_TRUST_HOST": "true",
    "WEB_API_MOCKING": "enabled",
}


def _env_example() -> dict[str, str]:
    pairs: dict[str, str] = {}
    for line in (REPO_ROOT / ".env.example").read_text(encoding="utf-8").splitlines():
        if line.strip() and not line.lstrip().startswith("#"):
            key, _, value = line.partition("=")
            assert key not in pairs, f"duplicate key {key}"
            pairs[key] = value
    return pairs


def test_module_env_keys_have_the_code_defaults() -> None:
    env = _env_example()
    assert {key: env.get(key) for key in MODULE_KEYS} == MODULE_KEYS


def test_mypy_covers_module_code_but_not_tests_or_migrations() -> None:
    mypy = tomllib.loads((REPO_ROOT / "pyproject.toml").read_text(encoding="utf-8"))["tool"]["mypy"]
    assert "apps/api/modules" in mypy["files"]
    assert {"apps/api/modules/[^/]+/tests/", "apps/api/modules/[^/]+/migrations/"} <= set(mypy["exclude"])
