import json
from datetime import datetime
from functools import lru_cache
from pathlib import Path
from typing import TYPE_CHECKING, Any, Literal
from uuid import UUID

from jsonschema import Draft202012Validator
from pydantic import BaseModel, ConfigDict

from api.platform.settings import get_settings

if TYPE_CHECKING:
    from api.platform.auth import CurrentUser


class EventActor(BaseModel):
    model_config = ConfigDict(frozen=True)

    type: Literal["USER", "SYSTEM"]
    user_id: UUID | None = None
    organization_id: UUID | None = None

    @classmethod
    def system(cls) -> "EventActor":
        return cls(type="SYSTEM")

    @classmethod
    def for_user(cls, user: "CurrentUser") -> "EventActor":
        return cls(type="USER", user_id=user.user_id, organization_id=user.organization_id)


class EventEnvelope(BaseModel):
    model_config = ConfigDict(frozen=True)

    event_id: UUID
    event_type: str
    occurred_at: datetime
    producer: str
    correlation_id: UUID
    actor: EventActor
    payload: dict[str, Any]


class EventSchemaError(ValueError):
    pass


@lru_cache(maxsize=4)
def _validators(schema_path: Path) -> dict[str, Draft202012Validator]:
    """One validator per event type (envelope + that type's variant), so errors name the exact field."""
    schema = json.loads(schema_path.read_text(encoding="utf-8"))
    variants = schema.pop("oneOf")
    validators: dict[str, Draft202012Validator] = {}
    for variant in variants:
        event_type = variant["properties"]["event_type"]["const"]
        validators[event_type] = Draft202012Validator(
            {**schema, "allOf": [variant]}, format_checker=Draft202012Validator.FORMAT_CHECKER
        )
    return validators


def validate_envelope(data: dict[str, Any]) -> None:
    validators = _validators(get_settings().contracts_dir / "events" / "p0_events.schema.json")
    event_type = str(data.get("event_type"))
    validator = validators.get(event_type)
    if validator is None:
        raise EventSchemaError(f"unknown event_type {event_type!r}")
    errors = sorted(validator.iter_errors(data), key=lambda e: [str(p) for p in e.absolute_path])
    if errors:
        location = "/".join(str(part) for part in errors[0].absolute_path) or "(root)"
        raise EventSchemaError(f"{event_type}: {location}: {errors[0].message}")
