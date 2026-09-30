import json

from api.platform.generated.error_codes import HTTP_STATUS, ErrorCode
from api.platform.generated.event_types import PRODUCER, EventType
from api.platform.settings import Settings


def test_every_contract_error_code_is_generated_with_its_http_status() -> None:
    codes = json.loads((Settings().contracts_dir / "error_codes.json").read_text())["codes"]
    assert {c["code"]: c["http"] for c in codes} == {code.value: HTTP_STATUS[code] for code in ErrorCode}


def test_every_contract_event_type_is_generated_with_its_producer() -> None:
    events = json.loads((Settings().contracts_dir / "events" / "index.json").read_text())["events"]
    assert {e["event_type"]: e["producer"] for e in events} == {t.value: PRODUCER[t] for t in EventType}


def test_event_member_names_follow_the_convention() -> None:
    assert EventType.PROJECT_ARCHIVED_V1 == "project.archived.v1"


def test_pydantic_api_models_are_importable() -> None:
    from nais_contracts.api_models import AccessRequestCreate

    assert "purpose_detail" in AccessRequestCreate.model_fields
