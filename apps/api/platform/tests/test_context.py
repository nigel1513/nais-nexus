import contextvars
import uuid

from api.platform import context


def test_correlation_id_is_generated_once_per_context() -> None:
    def read_twice() -> tuple[uuid.UUID, uuid.UUID]:
        return context.correlation_id(), context.correlation_id()

    first, second = contextvars.copy_context().run(read_twice)
    assert first == second
    assert first.version == 7


def test_use_correlation_id_sets_and_restores() -> None:
    def run() -> None:
        outer = context.correlation_id()
        pinned = uuid.UUID("0192f0c0-0000-7000-8000-000000000001")
        with context.use_correlation_id(pinned):
            assert context.correlation_id() == pinned
            assert context.trace_id() == pinned.hex
        assert context.correlation_id() == outer

    contextvars.copy_context().run(run)
