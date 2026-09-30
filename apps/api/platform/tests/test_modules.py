import sys
import types

import pytest

from api.platform.modules import ModuleSpec, discover_modules


def test_missing_modules_are_skipped() -> None:
    assert discover_modules(["does_not_exist"]) == []


def test_module_spec_is_discovered(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = types.ModuleType("api.modules.fake")
    fake.__file__ = "/virtual/api/modules/fake/__init__.py"
    fake.MODULE = ModuleSpec(name="fake", db_schema="fake")  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "api.modules.fake", fake)
    assert [spec.name for spec in discover_modules(["fake"])] == ["fake"]


def test_module_without_spec_is_an_error(monkeypatch: pytest.MonkeyPatch) -> None:
    broken = types.ModuleType("api.modules.broken")
    broken.__file__ = "/virtual/api/modules/broken/__init__.py"
    monkeypatch.setitem(sys.modules, "api.modules.broken", broken)
    with pytest.raises(TypeError, match="MODULE = ModuleSpec"):
        discover_modules(["broken"])
