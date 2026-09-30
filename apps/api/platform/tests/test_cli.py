from typing import Any

import pytest

from api.platform import cli


def test_migrate_passes_sql_flag(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, Any] = {}
    monkeypatch.setattr(cli, "discover_modules", lambda: [])
    monkeypatch.setattr(cli, "upgrade_all", lambda url, modules, sql=False: captured.update(url=url, sql=sql) or [])
    assert cli.main(["migrate", "--sql"]) == 0
    assert captured["sql"] is True
    assert "nais_migrator" in captured["url"]


def test_new_migration_for_unknown_module_fails(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    monkeypatch.setattr(cli, "discover_modules", lambda: [])
    assert cli.main(["new-migration", "ghost", "-m", "x"]) == 2
    assert "unknown module 'ghost'" in capsys.readouterr().err


def test_storage_init_uses_configured_org_codes(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: list[list[str]] = []
    monkeypatch.setattr(cli, "ensure_buckets", lambda codes: seen.append(list(codes)) or [])
    monkeypatch.setenv("STORAGE_ORG_CODES", "inst-a,inst-b")
    cli.get_settings.cache_clear()
    try:
        assert cli.main(["storage-init"]) == 0
    finally:
        cli.get_settings.cache_clear()
    assert seen == [["inst-a", "inst-b"]]
