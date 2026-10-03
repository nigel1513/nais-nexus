"""Internal endpoints for the web server (D-049): getInternalNotebookActivity and draftInternalNoteSections over the
shared Jupyter (fake contents API) and a fake LLM; the header token rule; Jupyter down -> 503 and a 0
draft_source_count on getNote."""

from collections.abc import Iterator
from dataclasses import dataclass
from datetime import date
from typing import Any
from uuid import UUID

import httpx
import pytest
from fastapi.testclient import TestClient

from api.modules.notes import MODULE
from api.modules.notes.adapters import JupyterNotebooks
from api.modules.notes.deps import NotesDeps
from api.modules.notes.interfaces import NotebookActivityPort
from api.modules.notes.settings import NotesSettings
from api.modules.notes.tests.conftest import NotesApi, World
from api.modules.notes.tests.fakes import JUPYTER_TOKEN, JUPYTER_URL, USERS, FakeJupyter, FakeLlm, FakePeople
from api.modules.notes.tests.test_jupyter import IN_DAY, SECRET, SECRET_OUTPUTS, code, md
from api.modules.notes.wiring import install
from api.platform import clock, ports
from api.platform.ids import new_id
from api.platform.jupyter import JupyterClient
from api.platform.llm import LlmTruncated, LlmUnavailable
from api.platform.testing.app import create_test_app
from api.platform.testing.contracts import assert_matches_response

TOKEN = "internal-test-token"
DAY = date(2026, 10, 3)
ACTIVITY = "/api/v1/internal/notes/notebook-activity"
DRAFT = "/api/v1/internal/notes/draft-sections"
HEADER = "X-NAIS-Internal-Token"


@dataclass
class Internal:
    client: TestClient
    jupyter: FakeJupyter
    llm: FakeLlm
    user_id: UUID
    project_id: UUID
    llm_enabled: bool = True
    token_setting: str = TOKEN

    def install(self) -> None:
        install(
            NotesDeps(
                settings=NotesSettings(nais_internal_token=self.token_setting),
                people=FakePeople(),
                llm=lambda: self.llm if self.llm_enabled else None,
            )
        )
        ports.provide(
            NotebookActivityPort,
            JupyterNotebooks(JupyterClient(JUPYTER_URL, JUPYTER_TOKEN, transport=self.jupyter.transport())),
        )

    def folder(self) -> str:
        return f"work/{self.user_id}/{self.project_id}"

    def activity(self, token: str | None = TOKEN, **params: Any) -> httpx.Response:
        query = {"user_id": str(self.user_id), "project_id": str(self.project_id), "day": DAY.isoformat()}
        return self.client.get(ACTIVITY, params=query | params, headers={HEADER: token} if token else {})

    def draft(self, token: str | None = TOKEN, **body: Any) -> httpx.Response:
        payload = {
            "user_id": str(self.user_id),
            "project_id": str(self.project_id),
            "day": DAY.isoformat(),
            "project_name": "전극 소재 열화 분석",
        }
        return self.client.post(DRAFT, json=payload | body, headers={HEADER: token} if token else {})


@pytest.fixture
def internal() -> Iterator[Internal]:
    app = create_test_app(modules=[MODULE])
    state = Internal(
        TestClient(app, raise_server_exceptions=False), FakeJupyter(), FakeLlm(), new_id(), new_id()
    )
    state.install()
    yield state


def analysis(state: Internal) -> None:
    state.jupyter.add_notebook(
        f"{state.folder()}/용량 분석.ipynb",
        IN_DAY,
        md("## 목표: 40도 이상 고온 구간의 용량 감소를 확인한다"),
        code("df = pd.read_csv('data/cycle.csv')"),
        code("df.groupby('temp').capacity.mean()", *SECRET_OUTPUTS),
    )


def answer(**sections: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        s: sections.get(s, [])
        for s in ("OBJECTIVE", "METHOD", "PROCEDURE", "RESULTS", "DISCUSSION", "NEXT", "REFERENCES")
    }


GOOD = answer(
    OBJECTIVE=[{"text": "고온 구간의 용량 감소를 확인한다.", "evidence": ["1.1"]}],
    PROCEDURE=[
        {"text": "사이클 데이터를 읽어 온도별 평균 용량을 계산했다.", "evidence": ["1.2", "1.3", "1.3"]}
    ],
    RESULTS=[{"text": "근거 없는 결과 문장.", "evidence": []}],
    REFERENCES=[{"text": "용량 분석", "evidence": []}],
)


# ---------------------------------------------------------------- token rule


@pytest.mark.parametrize("call", ["activity", "draft"])
def test_internal_endpoints_are_hidden_without_a_configured_token(internal: Internal, call: str) -> None:
    internal.token_setting = ""
    internal.install()
    response = getattr(internal, call)(token=TOKEN)
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "NOT_FOUND"
    assert getattr(internal, call)(token=None).status_code == 404


@pytest.mark.parametrize("call", ["activity", "draft"])
@pytest.mark.parametrize("token", [None, "wrong", TOKEN + "x"])
def test_internal_endpoints_refuse_a_missing_or_wrong_token(
    internal: Internal, call: str, token: str | None
) -> None:
    response = getattr(internal, call)(token=token)
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "FORBIDDEN"
    assert internal.jupyter.requests == [] and internal.llm.calls == []


def test_internal_endpoints_ignore_a_user_bearer_token(internal: Internal) -> None:
    response = internal.client.get(
        ACTIVITY,
        params={
            "user_id": str(internal.user_id),
            "project_id": str(internal.project_id),
            "day": DAY.isoformat(),
        },
        headers={"Authorization": f"Bearer {TOKEN}"},
    )
    assert response.status_code == 403


# ---------------------------------------------------------------- notebook activity


def test_notebook_activity_counts_the_day_from_listings(internal: Internal) -> None:
    analysis(internal)
    internal.jupyter.add_notebook(f"{internal.folder()}/old.ipynb", "2026-10-02T14:59:00Z", md("# old"))
    internal.jupyter.add_notebook(f"{internal.folder()}/data/x.ipynb", IN_DAY, md("# input"))
    response = internal.activity()
    assert response.status_code == 200, response.text
    body = response.json()
    assert_matches_response("getInternalNotebookActivity", 200, body)
    assert body == {
        "count": 1,
        "notebooks": [{"title": "용량 분석", "saved_at": "2026-10-03T01:20:00.123456Z", "cell_count": None}],
    }
    # The cheap path: the project listing only, no notebook read.
    assert internal.jupyter.contents_requests() == [("GET", internal.folder())]


def test_notebook_activity_detail_reads_the_notebooks(internal: Internal) -> None:
    analysis(internal)
    response = internal.activity(detail="true")
    assert response.status_code == 200, response.text
    body = response.json()
    assert_matches_response("getInternalNotebookActivity", 200, body)
    assert body == {
        "count": 1,
        "notebooks": [{"title": "용량 분석", "saved_at": "2026-10-03T01:20:00.123456Z", "cell_count": 3}],
    }
    assert ("GET", f"{internal.folder()}/용량 분석.ipynb") in internal.jupyter.contents_requests()
    assert SECRET not in response.text
    assert internal.activity(detail="false").json()["notebooks"][0]["cell_count"] is None


def test_notebook_activity_validates_ids(internal: Internal) -> None:
    response = internal.activity(user_id="../../etc")
    assert response.status_code == 422
    assert internal.jupyter.requests == []


def test_notebook_activity_is_503_when_jupyter_is_down(internal: Internal) -> None:
    internal.jupyter.down = True
    response = internal.activity()
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "DEPENDENCY_UNAVAILABLE"
    assert_matches_response("getInternalNotebookActivity", 503, response.json())


# ---------------------------------------------------------------- draft sections


def test_draft_sections_use_the_drafting_prompt_and_parser(internal: Internal) -> None:
    analysis(internal)
    internal.llm.script(GOOD)
    response = internal.draft()
    assert response.status_code == 200, response.text
    body = response.json()
    assert_matches_response("draftInternalNoteSections", 200, body)
    sections = body["sections"]
    assert list(sections) == [
        "OBJECTIVE",
        "METHOD",
        "PROCEDURE",
        "RESULTS",
        "DISCUSSION",
        "NEXT",
        "REFERENCES",
    ]
    assert sections["OBJECTIVE"] == [
        {
            "text": "고온 구간의 용량 감소를 확인한다.",
            "evidence": [{"label": "용량 분석 · 셀 1", "at": "2026-10-03T01:20:00.123456Z"}],
        }
    ]
    assert [e["label"] for e in sections["PROCEDURE"][0]["evidence"]] == [
        "용량 분석 · 셀 2",
        "용량 분석 · 셀 3",
    ]
    assert sections["RESULTS"] == []  # PROCEDURE/RESULTS need evidence (drafting/parse.py)
    assert sections["REFERENCES"] == [{"text": "용량 분석", "evidence": []}]
    [messages] = internal.llm.calls
    prompt = "\n".join(m.content for m in messages)
    assert "[1] 노트북 '용량 분석' (저장 10:20)" in prompt
    assert (
        "[1.3] 코드: df.groupby('temp').capacity.mean() / 출력: execute_result, stream, display_data, error 4개, 오류 있음"
        in prompt
    )
    assert SECRET not in prompt and SECRET not in response.text
    assert "전극 소재 열화 분석" not in prompt  # like the job, the prompt carries the notebooks alone


def test_draft_sections_retry_an_unusable_answer_once(internal: Internal) -> None:
    analysis(internal)
    internal.llm.script({"nothing": "useful"}, GOOD)
    response = internal.draft()
    assert response.status_code == 200
    assert len(internal.llm.calls) == 2
    internal.llm.script({"nothing": 1}, {"still": 2})
    response = internal.draft()
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "LLM_UNAVAILABLE"


@pytest.mark.parametrize("failure", [LlmUnavailable("timeout"), LlmTruncated("cut")])
def test_draft_sections_503_when_the_llm_fails(internal: Internal, failure: Exception) -> None:
    analysis(internal)
    internal.llm.script(failure)
    response = internal.draft()
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "LLM_UNAVAILABLE"
    assert len(internal.llm.calls) == 1


def test_draft_sections_503_when_the_llm_is_off(internal: Internal) -> None:
    analysis(internal)
    internal.llm_enabled = False
    response = internal.draft()
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "LLM_UNAVAILABLE"
    assert_matches_response("draftInternalNoteSections", 503, response.json())


def test_draft_sections_422_without_notebooks_that_day(internal: Internal) -> None:
    internal.jupyter.add_notebook(f"{internal.folder()}/old.ipynb", "2026-10-02T14:59:00Z", md("# old"))
    response = internal.draft()
    assert response.status_code == 422
    error = response.json()["error"]
    assert error["code"] == "VALIDATION_FAILED"
    assert error["details"]["reason"] == "NO_NOTEBOOK_ACTIVITY"
    assert_matches_response("draftInternalNoteSections", 422, response.json())
    assert internal.llm.calls == []


def test_draft_sections_503_when_jupyter_is_down(internal: Internal) -> None:
    internal.jupyter.down = True
    response = internal.draft()
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "DEPENDENCY_UNAVAILABLE"
    assert internal.llm.calls == []


# ---------------------------------------------------------------- getNote with Jupyter down (database)


def test_jupyter_down_leaves_draft_source_count_zero_and_draft_note_503(api: NotesApi, world: World) -> None:
    jupyter = FakeJupyter()
    user = USERS["a.recorder"]
    with clock.frozen(clock.now()):
        today = api.today(world)
        jupyter.add_notebook(
            f"work/{user.user_id}/{world.project_id}/a.ipynb",
            clock.now().isoformat().replace("+00:00", "Z"),
            md("# 목표"),
        )
        ports.provide(
            NotebookActivityPort,
            JupyterNotebooks(JupyterClient(JUPYTER_URL, JUPYTER_TOKEN, transport=jupyter.transport())),
        )
        assert api.get("a.recorder", f"/notes/{today['note_id']}").json()["draft_source_count"] == 1
        jupyter.down = True
        response = api.get("a.recorder", f"/notes/{today['note_id']}")
        assert response.status_code == 200
        assert response.json()["draft_source_count"] == 0
        drafted = api.post("a.recorder", f"/notes/{today['note_id']}/draft")
        assert drafted.status_code == 503
        assert drafted.json()["error"]["code"] == "DEPENDENCY_UNAVAILABLE"


# ---------------------------------------------------------------- fix round 1


@pytest.mark.parametrize(
    "raw",
    [
        b"",
        b"{not json",
        b"[]",
        b'{"user_id": "../x", "project_id": 1, "day": "yesterday"}',
        b'{"extra": true}',
    ],
)
def test_the_token_is_checked_before_the_body(internal: Internal, raw: bytes) -> None:
    def post(token: str | None) -> httpx.Response:
        headers = {"content-type": "application/json"} | ({HEADER: token} if token else {})
        return internal.client.post(DRAFT, content=raw, headers=headers)

    assert post("wrong").status_code == 403
    assert post(None).status_code == 403
    response = post(TOKEN)
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "VALIDATION_FAILED"
    internal.token_setting = ""
    internal.install()
    assert post(TOKEN).status_code == 404
    assert post("wrong").status_code == 404
    assert internal.jupyter.requests == [] and internal.llm.calls == []


@pytest.mark.parametrize("params", [{"user_id": "x"}, {"day": "nope"}, {"project_id": ""}])
def test_the_token_is_checked_before_the_query(internal: Internal, params: dict[str, str]) -> None:
    assert internal.activity(token="wrong", **params).status_code == 403
    assert internal.activity(token=TOKEN, **params).status_code == 422
    internal.token_setting = ""
    internal.install()
    assert internal.activity(token=TOKEN, **params).status_code == 404


def test_draft_sections_drop_repeats_like_the_job(internal: Internal) -> None:
    analysis(internal)
    internal.llm.script(
        answer(
            OBJECTIVE=[
                {"text": "고온 구간의 용량 감소를 확인한다.", "evidence": ["1.1"]},
                {"text": "같은 근거의 다른 표현.", "evidence": ["1.1"]},
            ],
            METHOD=[
                {"text": "pandas로 읽었다.", "evidence": []},
                {"text": "pandas로 읽었다.", "evidence": []},
            ],
        )
    )
    sections = internal.draft().json()["sections"]
    assert [s["text"] for s in sections["OBJECTIVE"]] == ["고온 구간의 용량 감소를 확인한다."]
    assert [s["text"] for s in sections["METHOD"]] == ["pandas로 읽었다."]


def test_draft_note_counts_once_from_listings(api: NotesApi, world: World) -> None:
    jupyter = FakeJupyter()
    user = USERS["a.recorder"]
    note = api.written(world)
    jupyter.add_notebook(
        f"work/{user.user_id}/{world.project_id}/a.ipynb",
        clock.now().isoformat().replace("+00:00", "Z"),
        md("# 목표"),
    )
    ports.provide(
        NotebookActivityPort,
        JupyterNotebooks(JupyterClient(JUPYTER_URL, JUPYTER_TOKEN, transport=jupyter.transport())),
    )
    response = api.post("a.recorder", f"/notes/{note['note_id']}/draft")
    assert response.status_code == 202, response.text
    assert response.json()["draft_source_count"] == 1
    # One listing walk (one request: a flat folder), no notebook read, one HTTP client.
    assert jupyter.contents_requests() == [("GET", f"work/{user.user_id}/{world.project_id}")]
    assert jupyter.clients_closed == 1
