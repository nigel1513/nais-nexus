"""Contract errors the notes module raises (codes from error_codes.json via the generated ErrorCode)."""

from api.platform.errors import ApiError
from api.platform.generated.error_codes import ErrorCode


def not_found(what: str = "Note") -> ApiError:
    return ApiError(ErrorCode.NOT_FOUND, f"{what} not found.")


def forbidden(message: str) -> ApiError:
    return ApiError(ErrorCode.FORBIDDEN, message)


def conflict(message: str) -> ApiError:
    return ApiError(ErrorCode.CONFLICT, message)


def locked() -> ApiError:
    return ApiError(
        ErrorCode.NOTE_LOCKED,
        "Submitted or signed research notes cannot be changed; a signed note is revised as a new version.",
    )


def not_witness() -> ApiError:
    return ApiError(ErrorCode.NOTE_NOT_WITNESS, "Only a witness of this submitted note can do this.")


def unaccepted_ai() -> ApiError:
    return ApiError(
        ErrorCode.NOTE_HAS_UNACCEPTED_AI, "Accept, edit or delete every AI sentence before submitting."
    )


def signature_expired() -> ApiError:
    return ApiError(ErrorCode.NOTE_SIGNATURE_EXPIRED, "Sign in again (within the last 5 minutes) to sign.")


def archived() -> ApiError:
    return ApiError(ErrorCode.PROJECT_ARCHIVED, "The project is archived; its research notes are read-only.")


def invalid(field: str, reason: str, message: str) -> ApiError:
    return ApiError(ErrorCode.VALIDATION_FAILED, message, {"fields": [{"field": field, "reason": reason}]})
