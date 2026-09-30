"""Tiny port registry: modules provide implementations, consumers look them up by Protocol type."""

from typing import TypeVar, cast

T = TypeVar("T")


class PortNotProvided(LookupError):
    pass


_registry: dict[object, object] = {}


def provide(port: type[T], impl: T) -> None:
    _registry[port] = impl


def get(port: type[T]) -> T:
    try:
        return cast(T, _registry[port])
    except KeyError:
        raise PortNotProvided(getattr(port, "__name__", repr(port))) from None


def reset() -> None:
    _registry.clear()
