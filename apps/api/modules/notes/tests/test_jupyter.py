"""The shared Jupyter as the drafting source: platform JupyterClient + notes JupyterNotebooks over a fake contents
API (httpx.MockTransport). No database."""

import json
from datetime import UTC, date, datetime
from typing import Any
from uuid import UUID

import httpx
import pytest

from api.modules.notes.adapters import JupyterNotebooks
from api.modules.notes.drafting.prompt import build_messages, notebooks, plan
from api.modules.notes.interfaces import NotebookActivityPort
from api.modules.notes.tests.fakes import JUPYTER_TOKEN, JUPYTER_URL, FakeJupyter
from api.modules.notes.wiring import provide_notebooks
from api.platform import ports
from api.platform.ids import new_id
from api.platform.jupyter import JupyterClient, JupyterUnavailable
from api.platform.settings import Settings

DAY = date(2026, 10, 3)
# KST = UTC+9: 2026-10-03 KST runs from 2026-10-02T15:00Z to 2026-10-03T15:00Z.
IN_DAY = "2026-10-03T01:20:00.123456Z"  # 10:20 KST
EARLY_KST = "2026-10-02T15:30:00Z"  # 00:30 KST on the 3rd
LATE_PREVIOUS = "2026-10-02T14:59:00Z"  # 23:59 KST on the 2nd
NEXT_DAY = "2026-10-03T15:30:00Z"  # 00:30 KST on the 4th
SECRET = "S3CR3T-VALUE-42"


def md(source: Any) -> dict[str, Any]:
    return {"cell_type": "markdown", "source": source, "metadata": {}}


def code(source: Any, *outputs: dict[str, Any]) -> dict[str, Any]:
    return {
        "cell_type": "code",
        "source": source,
        "outputs": list(outputs),
        "execution_count": 1,
        "metadata": {},
    }


SECRET_OUTPUTS = (
    {
        "output_type": "execute_result",
        "data": {"text/plain": f"'{SECRET}'"},
        "metadata": {},
        "execution_count": 1,
    },
    {"output_type": "stream", "name": "stdout", "text": f"token={SECRET}\n"},
    {
        "output_type": "display_data",
        "data": {"image/png": f"iVBOR{SECRET}", "text/plain": f"<Figure {SECRET}>"},
    },
    {"output_type": "error", "ename": f"E{SECRET}", "evalue": SECRET, "traceback": [SECRET]},
)


def client(fake: FakeJupyter, token: str = JUPYTER_TOKEN) -> JupyterClient:
    return JupyterClient(JUPYTER_URL, token, transport=fake.transport())


def adapter(fake: FakeJupyter) -> JupyterNotebooks:
    return JupyterNotebooks(client(fake))


def folder(user_id: UUID, project_id: UUID) -> str:
    return f"work/{user_id}/{project_id}"


# ---------------------------------------------------------------- client


def test_client_sends_the_token_and_encodes_paths() -> None:
    fake = FakeJupyter()
    fake.add_notebook("work/a b/분석.ipynb", IN_DAY, md("# x"))
    entries = client(fake).list_dir("work/a b")
    assert [(e["name"], e["type"]) for e in entries] == [("분석.ipynb", "notebook")]
    request = fake.requests[-1]
    assert request.headers["Authorization"] == f"token {JUPYTER_TOKEN}"
    assert request.url.raw_path.decode().startswith("/notebooks/api/contents/work/a%20b")
    assert request.url.params["content"] == "1"
    model = client(fake).get_notebook("work/a b/분석.ipynb")
    assert model is not None and model["type"] == "notebook"


def test_client_answers_nothing_for_a_missing_path() -> None:
    fake = FakeJupyter()
    assert client(fake).list_dir("work/nobody") == []
    assert client(fake).get_notebook("work/nobody/x.ipynb") is None


@pytest.mark.parametrize("path", ["../etc", "work/../x", "/work", "work//x", "work/./x", "work\\x"])
def test_client_refuses_unsafe_paths(path: str) -> None:
    fake = FakeJupyter()
    with pytest.raises(ValueError):
        client(fake).list_dir(path)
    with pytest.raises(ValueError):
        client(fake).ensure_dir(path)
    assert fake.requests == []


def test_client_fails_when_jupyter_is_down_or_refuses_the_token() -> None:
    fake = FakeJupyter()
    with pytest.raises(JupyterUnavailable):
        client(fake, token="wrong").list_dir("work")
    fake.down = True
    with pytest.raises(JupyterUnavailable):
        client(fake).list_dir("work")
    with pytest.raises(JupyterUnavailable):
        client(fake).get_notebook("work/x.ipynb")


def test_client_fails_on_an_answer_that_is_not_json() -> None:
    transport = httpx.MockTransport(lambda request: httpx.Response(200, text="<html>"))
    with pytest.raises(JupyterUnavailable):
        JupyterClient(JUPYTER_URL, JUPYTER_TOKEN, transport=transport).list_dir("work")


def test_ensure_dir_creates_every_level() -> None:
    fake = FakeJupyter()
    user_id, project_id = new_id(), new_id()
    client(fake).ensure_dir(f"{folder(user_id, project_id)}/data")
    puts = [r for r in fake.requests if r.method == "PUT"]
    assert [json.loads(r.content) for r in puts] == [{"type": "directory"}] * 4
    assert fake.dirs == {
        "work",
        f"work/{user_id}",
        folder(user_id, project_id),
        f"{folder(user_id, project_id)}/data",
    }


# ---------------------------------------------------------------- activity


def test_activity_is_the_notebooks_saved_that_day_in_kst() -> None:
    fake = FakeJupyter()
    user_id, project_id = new_id(), new_id()
    base = folder(user_id, project_id)
    fake.add_notebook(f"{base}/morning.ipynb", IN_DAY, md("# 목표"))
    fake.add_notebook(f"{base}/early.ipynb", EARLY_KST, md("# early"))
    fake.add_notebook(f"{base}/yesterday.ipynb", LATE_PREVIOUS, md("# old"))
    fake.add_notebook(f"{base}/tomorrow.ipynb", NEXT_DAY, md("# new"))
    fake.add_file(f"{base}/README.md", IN_DAY)
    activity = adapter(fake).list_notebook_activity(user_id, project_id, DAY)
    assert sorted(a.title for a in activity) == ["early", "morning"]
    morning = next(a for a in activity if a.title == "morning")
    assert morning.saved_at == datetime(2026, 10, 3, 1, 20, 0, 123456, tzinfo=UTC)
    assert morning.version_id is None
    # A stable id per notebook path (the drafting evidence ref).
    again = adapter(fake).list_notebook_activity(user_id, project_id, DAY)
    assert {a.notebook_id for a in again} == {a.notebook_id for a in activity}


def test_activity_skips_data_checkpoints_and_too_deep_folders() -> None:
    fake = FakeJupyter()
    user_id, project_id = new_id(), new_id()
    base = folder(user_id, project_id)
    fake.add_notebook(f"{base}/sub/a/b/deep.ipynb", IN_DAY, md("# depth 3"))
    fake.add_notebook(f"{base}/sub/a/b/c/deeper.ipynb", IN_DAY, md("# depth 4"))
    fake.add_notebook(f"{base}/data/input.ipynb", IN_DAY, md("# data"))
    fake.add_notebook(f"{base}/.ipynb_checkpoints/x-checkpoint.ipynb", IN_DAY, md("# cp"))
    fake.add_notebook(f"{base}/sub/.ipynb_checkpoints/y-checkpoint.ipynb", IN_DAY, md("# cp"))
    fake.add_notebook(f"{base}/sub/data/kept.ipynb", IN_DAY, md("# only the top data/ is input"))
    activity = adapter(fake).list_notebook_activity(user_id, project_id, DAY)
    assert sorted(a.title for a in activity) == ["deep", "kept"]
    listed = [r.url.path.rstrip("/") for r in fake.requests]
    assert f"/notebooks/api/contents/{base}/data" not in listed  # the project's data/ is never even listed
    assert not any("ipynb_checkpoints" in p for p in listed)


def test_activity_walk_stops_after_max_entries() -> None:
    fake = FakeJupyter()
    user_id, project_id = new_id(), new_id()
    base = folder(user_id, project_id)
    for n in range(260):
        fake.add_file(f"{base}/f{n:03}.csv", IN_DAY)
    fake.add_notebook(f"{base}/zz-late.ipynb", IN_DAY, md("# after the cap"))
    assert adapter(fake).list_notebook_activity(user_id, project_id, DAY) == []
    assert len(fake.requests) == 1


def test_cells_carry_source_heads_and_output_kinds_never_output_values() -> None:
    fake = FakeJupyter()
    user_id, project_id = new_id(), new_id()
    fake.add_notebook(
        f"{folder(user_id, project_id)}/분석.ipynb",
        IN_DAY,
        md(["## 목표\n", "고온 구간 용량"]),
        code("x" * 1000, *SECRET_OUTPUTS),
        code("df.head()", {"output_type": "stream", "name": "stdout", "text": SECRET}),
        {"cell_type": "raw", "source": f"raw {SECRET}", "metadata": {}},
        code("odd()", {"output_type": f"weird-{SECRET}", "data": {}}),
    )
    [activity] = adapter(fake).list_notebook_activity(user_id, project_id, DAY)
    assert activity.title == "분석"
    first, big, small, odd = activity.cells
    assert (first.type, first.source_head, first.output_kinds, first.output_count) == (
        "markdown",
        "## 목표\n고온 구간 용량",
        (),
        0,
    )
    assert big.type == "code" and len(big.source_head) == 400
    assert big.output_kinds == ("execute_result", "stream", "display_data", "error")
    assert (big.output_count, big.has_error) == (4, True)
    assert (small.output_kinds, small.output_count, small.has_error) == (("stream",), 1, False)
    assert odd.output_kinds == ("other",)
    assert SECRET not in repr(activity)
    messages = build_messages(DAY, plan(notebooks([activity])))
    assert SECRET not in "".join(m.content for m in messages)


def test_activity_for_all_projects_and_bad_folders_ignored() -> None:
    fake = FakeJupyter()
    user_id, p1, p2 = new_id(), new_id(), new_id()
    fake.add_notebook(f"{folder(user_id, p1)}/one.ipynb", IN_DAY, md("# 1"))
    fake.add_notebook(f"{folder(user_id, p2)}/two.ipynb", IN_DAY, md("# 2"))
    fake.add_notebook(f"work/{user_id}/not-a-uuid/three.ipynb", IN_DAY, md("# 3"))
    fake.add_notebook(f"work/{user_id}/{str(p1).upper()}/four.ipynb", IN_DAY, md("# 4"))
    activity = adapter(fake).list_notebook_activity(user_id, None, DAY)
    assert sorted(a.title for a in activity) == ["one", "two"]
    assert adapter(fake).list_notebook_activity(user_id, new_id(), DAY) == []  # no folder yet


def test_authors_are_canonical_uuid_folders_with_a_notebook_that_day() -> None:
    fake = FakeJupyter()
    u1, u2, p1, p2, p3 = new_id(), new_id(), new_id(), new_id(), new_id()
    fake.add_notebook(f"{folder(u1, p1)}/a.ipynb", IN_DAY, md("# a"))
    fake.add_notebook(f"{folder(u1, p2)}/old.ipynb", LATE_PREVIOUS, md("# old"))
    fake.add_notebook(f"{folder(u2, p3)}/sub/b.ipynb", EARLY_KST, md("# b"))
    fake.add_notebook(f"{folder(u2, p1)}/data/in.ipynb", IN_DAY, md("# data only"))
    fake.add_notebook(f"work/not-a-uuid/{p1}/c.ipynb", IN_DAY, md("# c"))
    fake.add_notebook(f"work/{str(u1).upper()}/{p1}/d.ipynb", IN_DAY, md("# d"))
    fake.add_notebook(f"work/{u1}/../{p1}/e.ipynb", IN_DAY, md("# e"))
    fake.add_notebook(f"work/{u1}/x.ipynb", IN_DAY, md("# loose"))
    authors = adapter(fake).list_notebook_authors(DAY)
    assert sorted(authors) == sorted([(u1, p1), (u2, p3)])
    assert not any(r.url.path.endswith("a.ipynb") for r in fake.requests)  # listings suffice


def test_activity_fails_when_jupyter_is_down() -> None:
    fake = FakeJupyter()
    fake.down = True
    with pytest.raises(JupyterUnavailable):
        adapter(fake).list_notebook_activity(new_id(), new_id(), DAY)
    with pytest.raises(JupyterUnavailable):
        adapter(fake).list_notebook_authors(DAY)


# ---------------------------------------------------------------- wiring


def test_jupyter_is_the_notebook_source_only_when_configured() -> None:
    provide_notebooks(Settings(nais_jupyter_url=None))
    with pytest.raises(ports.PortNotProvided):
        ports.get(NotebookActivityPort)
    provide_notebooks(Settings(nais_jupyter_url=JUPYTER_URL, nais_jupyter_token=JUPYTER_TOKEN))
    assert isinstance(ports.get(NotebookActivityPort), JupyterNotebooks)


# ---------------------------------------------------------------- fix round 1: bounded walks, cheap count, limits


def test_client_fails_on_401_and_on_timeouts() -> None:
    unauthorized = httpx.MockTransport(lambda request: httpx.Response(401, json={"message": "Unauthorized"}))
    with pytest.raises(JupyterUnavailable):
        JupyterClient(JUPYTER_URL, JUPYTER_TOKEN, transport=unauthorized).list_dir("work")

    def slow(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("timed out", request=request)

    with pytest.raises(JupyterUnavailable):
        JupyterClient(JUPYTER_URL, JUPYTER_TOKEN, transport=httpx.MockTransport(slow)).get_notebook(
            "work/a.ipynb"
        )


def test_a_walk_uses_one_http_client() -> None:
    fake = FakeJupyter()
    user_id, p1, p2 = new_id(), new_id(), new_id()
    for n in range(3):
        fake.add_notebook(f"{folder(user_id, p1)}/s{n}/n{n}.ipynb", IN_DAY, md(f"# {n}"))
    fake.add_notebook(f"{folder(user_id, p2)}/x.ipynb", IN_DAY, md("# x"))
    assert len(adapter(fake).list_notebook_activity(user_id, p1, DAY)) == 3
    assert len(fake.requests) == 7 and fake.clients_closed == 1  # 4 listings + 3 notebooks, one client
    assert adapter(fake).count_notebooks(user_id, p1, DAY) == 3
    assert fake.clients_closed == 2
    assert sorted(adapter(fake).list_notebook_authors(DAY)) == sorted([(user_id, p1), (user_id, p2)])
    assert fake.clients_closed == 3


def test_a_walk_stops_when_its_time_budget_is_spent() -> None:
    fake = FakeJupyter()
    fake.delay = 0.05
    user_id, project_id = new_id(), new_id()
    for n in range(10):
        fake.add_notebook(f"{folder(user_id, project_id)}/s{n}/n.ipynb", IN_DAY, md("# n"))
    notebooks_port = JupyterNotebooks(client(fake), activity_budget_s=0.12, authors_budget_s=0.12)
    with pytest.raises(JupyterUnavailable, match="budget"):
        notebooks_port.list_notebook_activity(user_id, project_id, DAY)
    assert len(fake.requests) <= 4
    fake.requests.clear()
    with pytest.raises(JupyterUnavailable, match="budget"):
        notebooks_port.count_notebooks(user_id, project_id, DAY)
    with pytest.raises(JupyterUnavailable, match="budget"):
        notebooks_port.list_notebook_authors(DAY)


def test_default_budgets_are_5_s_for_a_researcher_and_30_s_for_the_evening_scan() -> None:
    port = JupyterNotebooks(client(FakeJupyter()))
    assert (port.activity_budget_s, port.authors_budget_s) == (5.0, 30.0)


def test_count_reads_listings_only() -> None:
    fake = FakeJupyter()
    user_id, project_id = new_id(), new_id()
    base = folder(user_id, project_id)
    fake.add_notebook(f"{base}/a.ipynb", IN_DAY, md("# a"))
    fake.add_notebook(f"{base}/sub/b.ipynb", EARLY_KST, md("# b"))
    fake.add_notebook(f"{base}/old.ipynb", LATE_PREVIOUS, md("# old"))
    fake.add_notebook(f"{base}/data/in.ipynb", IN_DAY, md("# data"))
    assert adapter(fake).count_notebooks(user_id, project_id, DAY) == 2
    assert [path for _, path in fake.contents_requests()] == [base, f"{base}/sub"]


def test_oversized_notebooks_are_skipped(caplog: pytest.LogCaptureFixture) -> None:
    fake = FakeJupyter()
    user_id, project_id = new_id(), new_id()
    base = folder(user_id, project_id)
    fake.add_notebook(f"{base}/small.ipynb", IN_DAY, md("# small"))
    fake.add_notebook(
        f"{base}/huge.ipynb",
        IN_DAY,
        code("plot()", {"output_type": "display_data", "data": {"image/png": "A" * 5000}}),
    )
    small_cap = JupyterClient(JUPYTER_URL, JUPYTER_TOKEN, max_bytes=3000, transport=fake.transport())
    activity = JupyterNotebooks(small_cap).list_notebook_activity(user_id, project_id, DAY)
    assert [a.title for a in activity] == ["small"]
    [record] = [r for r in caplog.records if r.getMessage() == "notebooks skipped: too large"]
    assert record.skipped == 1


def test_default_size_cap_is_20_mib() -> None:
    from api.platform.jupyter import MAX_BYTES

    assert MAX_BYTES == 20 * 1024 * 1024


def test_jupyter_requests_are_not_logged_but_other_clients_are(caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level("INFO", logger="httpx")
    fake = FakeJupyter()
    client(fake).list_dir("work")
    other = httpx.MockTransport(lambda request: httpx.Response(200, json={}))
    with httpx.Client(transport=other) as http:
        http.get("http://llm.internal/v1/models")
    messages = [r.getMessage() for r in caplog.records if r.name == "httpx"]
    assert not any("notebook" in m for m in messages)
    assert any("llm.internal" in m for m in messages)
