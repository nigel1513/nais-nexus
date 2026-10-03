"""Opt-in smoke against the REAL shared GPU (skipped unless NAIS_LIVE_LLM=1; CI never runs it).

The GPU is shared with another platform, so the calls are few: the draft test makes 1–2 chat calls (the job retries
once on an unusable answer), the other test one embedding and one rerank call. Run:

    NAIS_LIVE_LLM=1 NAIS_LLM_ENABLED=true NAIS_LLM_BASE_URL=http://192.168.0.2:8001 \
    NAIS_EMBED_BASE_URL=http://192.168.0.2:8002 NAIS_RERANK_BASE_URL=http://192.168.0.2:8003 \
    uv run pytest apps/api/modules/notes/tests/test_live_llm.py -m live_llm -s -q

1. `notes.draft_note` once (1–2 chat calls) on the testcontainer database: a fake NotebookActivityPort returns one realistic notebook
   (Korean markdown + code cells about battery capacity fade, output kinds/counts only) and the platform LLM client
   (api.platform.llm.get_llm_client, i.e. NAIS_LLM_*) answers. The produced AI blocks and the latency are printed.
2. One embedding call and one rerank call through the platform clients.
"""

import json
import os
import time
from datetime import UTC, date, datetime, timedelta
from typing import Any
from uuid import UUID

import pytest

from api.modules.notes import jobs
from api.modules.notes.deps import NotesDeps
from api.modules.notes.drafting.parse import NEEDS_EVIDENCE, parse_draft
from api.modules.notes.drafting.prompt import notebooks, plan
from api.modules.notes.interfaces import NotebookCell
from api.modules.notes.settings import NotesSettings
from api.modules.notes.tests.conftest import NotesApi, World
from api.modules.notes.tests.fakes import USERS, notebook
from api.modules.notes.wiring import install
from api.platform import clock
from api.platform.llm import ChatMessage, get_embedding_client, get_llm_client, get_rerank_client
from api.platform.settings import get_settings

pytestmark = [
    pytest.mark.live_llm,
    pytest.mark.skipif(os.environ.get("NAIS_LIVE_LLM") != "1", reason="live GPU smoke: set NAIS_LIVE_LLM=1"),
]

NOW = datetime(2026, 10, 2, 10, 30, tzinfo=UTC)  # 19:30 KST
TODAY = date(2026, 10, 2)

CELLS = (
    NotebookCell(
        "markdown",
        "# 고온 사이클 용량 감소 분석\n45°C 충방전 시험에서 NCM811 셀의 용량 유지율을 확인한다.",
        (),
        0,
        False,
    ),
    NotebookCell(
        "code",
        "import pandas as pd\ndf = pd.read_csv('ncm811_45c_cycle.csv')\ndf.shape",
        ("execute_result",),
        1,
        False,
    ),
    NotebookCell(
        "code",
        "df['retention'] = df.discharge_capacity / df.discharge_capacity.iloc[0] * 100\ndf[['cycle', 'retention']].tail()",
        ("execute_result",),
        1,
        False,
    ),
    NotebookCell(
        "code", "ax = df.plot(x='cycle', y='retention')\nax.axhline(80, ls='--')", ("display_data",), 1, False
    ),
    NotebookCell(
        "markdown",
        "## 관찰\n300 사이클 이후 유지율 감소 기울기가 커진다. 25°C 대조군과 비교가 필요하다.",
        (),
        0,
        False,
    ),
    NotebookCell("code", "fit = np.polyfit(df.cycle, df.retention, 1)\nfit", ("execute_result",), 1, False),
    NotebookCell(
        "markdown",
        "## 다음\n25°C 대조군 데이터를 같은 방식으로 분석하고 dQ/dV 곡선을 비교한다.",
        (),
        0,
        False,
    ),
)


class Timed:
    """The real platform client, recording the raw answer and the wall time of each call."""

    def __init__(self) -> None:
        client = get_llm_client()
        assert client is not None, "set NAIS_LLM_ENABLED=true and NAIS_LLM_BASE_URL"
        self.client = client
        self.answers: list[dict[str, Any]] = []
        self.seconds: list[float] = []

    def chat_json(
        self, messages: list[ChatMessage], *, max_tokens: int = 800, temperature: float = 0.2
    ) -> dict[str, Any]:
        start = time.perf_counter()
        try:
            answer = self.client.chat_json(messages, max_tokens=max_tokens, temperature=temperature)
        finally:
            self.seconds.append(time.perf_counter() - start)
        self.answers.append(answer)
        return answer


@pytest.fixture
def live_llm(request: pytest.FixtureRequest, api: NotesApi, world: World) -> Timed:
    """The real chat client as the notes LLM (after `api` has installed the fakes); a finalizer puts the world's fake
    deps and notebook port back, so nothing live leaks into a later test in the same process."""
    llm = Timed()
    install(NotesDeps(settings=NotesSettings(), people=world.people, llm=lambda: llm))
    request.addfinalizer(world.install)
    return llm


def test_live_draft_note(api: NotesApi, world: World, live_llm: Timed) -> None:
    llm = live_llm
    saved = notebook("NCM811 45도 사이클 분석", *CELLS, saved_at=NOW - timedelta(hours=2))
    world.notebooks.add(
        USERS["a.recorder"], world.project_id, TODAY, saved
    )  # world.install provided this port
    with clock.frozen(NOW):
        note = api.today(world)
        response = api.post("a.recorder", f"/notes/{note['note_id']}/draft")
        assert response.status_code == 202, response.text
        status = jobs.draft_note(UUID(note["note_id"]))
        body = api.get("a.recorder", f"/notes/{note['note_id']}").json()

    print(f"\n[live] status={status} calls={len(llm.seconds)} latency_s={[round(s, 1) for s in llm.seconds]}")
    for i, answer in enumerate(llm.answers, 1):
        print(f"[live] raw answer {i}: {json.dumps(answer, ensure_ascii=False)}")
    ai = [b for b in body["blocks"] if b["origin"] == "AI"]
    for b in ai:
        labels = [e["label"] for e in b["evidence"]]
        print(f"[live] {b['section']:<10} {b['text']}  evidence={labels}")
    print(f"[live] AI sentences={len(ai)} sections={sorted({b['section'] for b in ai})}")

    assert status == "DONE", body.get("draft_error")
    assert body["draft_status"] == "DONE"
    assert ai, "the model produced no usable sentence"
    assert all(not b["accepted"] for b in ai)
    assert all(b["evidence"] for b in ai if b["section"] in NEEDS_EVIDENCE)
    # the last answer parses on its own (the job retries once on an unusable one)
    assert llm.answers and parse_draft(llm.answers[-1], plan(notebooks([saved])).items)


def test_live_embedding_and_rerank() -> None:
    settings = get_settings()
    embedder, reranker = get_embedding_client(), get_rerank_client()
    assert embedder is not None and reranker is not None, "set NAIS_EMBED_BASE_URL and NAIS_RERANK_BASE_URL"
    texts = [
        "45도 사이클 시험에서 NCM811 셀의 용량 유지율이 300 사이클 이후 빠르게 감소했다.",
        "전해질 첨가제 조성 비교",
    ]
    start = time.perf_counter()
    vectors = embedder.embed(texts)
    embed_s = time.perf_counter() - start
    start = time.perf_counter()
    scores = reranker.rerank("고온 용량 감소", texts)
    rerank_s = time.perf_counter() - start
    print(
        f"\n[live] embed model={settings.nais_embed_model} dims={[len(v) for v in vectors]} {embed_s:.2f}s;"
        f" rerank model={settings.nais_rerank_model} scores={[round(s, 4) for s in scores]} {rerank_s:.2f}s"
    )
    assert len(vectors) == 2 and all(len(v) == len(vectors[0]) > 0 for v in vectors)
    assert len(scores) == 2 and scores[0] > scores[1]
