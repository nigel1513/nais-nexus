import time
import uuid

from api.platform.ids import new_id


def test_new_id_is_uuid_version_7() -> None:
    value = new_id()
    assert value.variant == uuid.RFC_4122
    assert value.version == 7


def test_new_id_embeds_current_unix_milliseconds() -> None:
    before = time.time_ns() // 1_000_000
    value = new_id()
    after = time.time_ns() // 1_000_000
    assert before <= value.int >> 80 <= after


def test_new_ids_are_unique() -> None:
    assert len({new_id() for _ in range(10_000)}) == 10_000


def test_ids_from_later_milliseconds_sort_later() -> None:
    first = new_id()
    time.sleep(0.002)
    second = new_id()
    assert str(first) < str(second)
