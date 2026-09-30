from typing import Protocol

import pytest

from api.platform import ports


class GreeterPort(Protocol):
    def greet(self) -> str: ...


class Greeter:
    def greet(self) -> str:
        return "hi"


def test_provide_and_get() -> None:
    ports.provide(GreeterPort, Greeter())
    assert ports.get(GreeterPort).greet() == "hi"


def test_missing_port_raises() -> None:
    with pytest.raises(ports.PortNotProvided, match="GreeterPort"):
        ports.get(GreeterPort)
