"""One file per check (M05 §2). Each exposes check(ctx) -> CheckOutcome and must stay deterministic:
no clock, no randomness, no network, no environment reads (M05-AT-14 enforces this)."""

from collections.abc import Callable

from api.modules.readiness.engine.context import CheckOutcome, EvaluationContext
from api.modules.readiness.validators import (
    datatype_validity,
    file_checksum,
    license_usage,
    mapping_status,
    metadata_completeness,
    missing_values,
    provenance_presence,
    schema_presence,
    units_codebook,
)

Validator = Callable[[EvaluationContext], CheckOutcome]

VALIDATORS: dict[str, Validator] = {
    "metadata.completeness": metadata_completeness.check,
    "schema.presence": schema_presence.check,
    "schema.datatype_validity": datatype_validity.check,
    "data.missing_values": missing_values.check,
    "semantics.units_codebook": units_codebook.check,
    "provenance.presence": provenance_presence.check,
    "policy.license_usage": license_usage.check,
    "integrity.file_checksum": file_checksum.check,
    "semantics.mapping_status": mapping_status.check,
}
