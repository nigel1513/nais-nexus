"""Map storage failures to the contract error envelope."""

from collections.abc import Iterator
from contextlib import contextmanager

from api.modules.catalog.objects import StorageUnavailable
from api.platform.errors import ApiError
from api.platform.generated.error_codes import ErrorCode
from api.platform.storage import StorageNotConfigured


@contextmanager
def dependency_errors() -> Iterator[None]:
    try:
        yield
    except StorageUnavailable as exc:
        raise ApiError(
            ErrorCode.DEPENDENCY_UNAVAILABLE, "Object storage is temporarily unavailable."
        ) from exc
    except StorageNotConfigured as exc:
        raise ApiError(
            ErrorCode.DEPENDENCY_UNAVAILABLE, "Object storage is not configured for this organization."
        ) from exc
