"""Contract errors the workspace raises (codes from error_codes.json via the generated ErrorCode)."""

from uuid import UUID

from api.platform.errors import ApiError
from api.platform.generated.error_codes import ErrorCode


def not_found(what: str = "Resource") -> ApiError:
    return ApiError(ErrorCode.NOT_FOUND, f"{what} not found.")


def forbidden(message: str) -> ApiError:
    return ApiError(ErrorCode.FORBIDDEN, message)


def access_required(dataset_id: UUID) -> ApiError:
    """403 ACCESS_REQUIRED; details.dataset_id lets the client link the access request."""
    return ApiError(
        ErrorCode.ACCESS_REQUIRED,
        "An active access grant for this dataset is required.",
        {"dataset_id": str(dataset_id)},
    )
