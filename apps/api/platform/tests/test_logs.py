import json
import logging
import uuid

from api.platform import context
from api.platform.logs import JsonFormatter


def test_json_formatter_includes_trace_id_and_extras() -> None:
    pinned = uuid.UUID("0192f0c0-0000-7000-8000-0000000000aa")
    record = logging.LogRecord("nais.test", logging.INFO, __file__, 1, "hello %s", ("world",), None)
    record.event_id = "e-1"
    with context.use_correlation_id(pinned):
        line = JsonFormatter().format(record)
    payload = json.loads(line)
    assert payload["message"] == "hello world"
    assert payload["level"] == "INFO"
    assert payload["trace_id"] == pinned.hex
    assert payload["event_id"] == "e-1"
