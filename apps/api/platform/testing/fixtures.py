"""Shared pytest fixtures for platform and module tests (registered from the root conftest.py)."""

from collections.abc import Iterator

import pytest

from api.platform import ports


@pytest.fixture(autouse=True)
def _reset_ports() -> Iterator[None]:
    yield
    ports.reset()
