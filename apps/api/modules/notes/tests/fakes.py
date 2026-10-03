"""In-memory stand-ins for the ports the notes module consumes (project membership, display names, notebooks)."""

from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Any
from urllib.parse import unquote
from uuid import UUID

import httpx
from nais_contracts.api_models import ProjectSummary

from api.modules.notes.interfaces import NotebookActivity, NotebookCell
from api.platform.auth import CurrentUser
from api.platform.ids import new_id
from api.platform.llm import ChatMessage

ORG_A = UUID("00000000-0000-7000-8000-00000000000a")
ORG_B = UUID("00000000-0000-7000-8000-00000000000b")
ORG_C = UUID("00000000-0000-7000-8000-00000000000c")


def _user(suffix: str, org: UUID, name: str, roles: frozenset[str] = frozenset()) -> CurrentUser:
    return CurrentUser(
        user_id=UUID(f"00000000-0000-7000-8000-00000000{suffix}"),
        organization_id=org,
        org_roles=roles,
        session_id=f"s-{suffix}",
        display_name=name,
    )


USERS: dict[str, CurrentUser] = {
    "a.recorder": _user("0a01", ORG_A, "김민준"),
    "a.colleague": _user("0a07", ORG_A, "이서연"),
    "a.member": _user("0a05", ORG_A, "A Member"),
    "a.owner": _user("0a03", ORG_A, "A Owner"),
    "a.admin": _user("0a04", ORG_A, "A Admin", frozenset({"ORG_ADMIN"})),
    "b.witness": _user("0b02", ORG_B, "박지훈"),
    "b.recorder": _user("0b01", ORG_B, "B Recorder"),
    "b.admin": _user("0b04", ORG_B, "B Admin", frozenset({"ORG_ADMIN"})),
    "c.outsider": _user("0c01", ORG_C, "C Outsider"),
}


@dataclass
class FakeProjects:
    """ProjectQueryPort: project_id -> {user_id: role}; archived projects keep roles but are not "active"."""

    roles: dict[UUID, dict[UUID, str]] = field(default_factory=dict)
    archived: set[UUID] = field(default_factory=set)
    names: dict[UUID, str] = field(default_factory=dict)

    def add(self, project_id: UUID, user: CurrentUser, role: str = "RESEARCHER") -> None:
        self.roles.setdefault(project_id, {})[user.user_id] = role
        self.names.setdefault(project_id, "전극 소재 열화 분석")

    def remove(self, project_id: UUID, user: CurrentUser) -> None:
        self.roles.get(project_id, {}).pop(user.user_id, None)

    def is_active_member(self, project_id: UUID, user_id: UUID) -> bool:
        return project_id not in self.archived and user_id in self.roles.get(project_id, {})

    def get_member_role(self, project_id: UUID, user_id: UUID) -> str | None:
        return self.roles.get(project_id, {}).get(user_id)

    def get_summary(self, project_id: UUID) -> ProjectSummary | None:
        if project_id not in self.names:
            return None
        return ProjectSummary.model_validate(
            {
                "project_id": project_id,
                "name": self.names[project_id],
                "status": "ARCHIVED" if project_id in self.archived else "ACTIVE",
                "visibility": "PRIVATE",
                "lead_organization_id": ORG_A,
            }
        )

    def list_active_member_ids(self, project_id: UUID) -> list[UUID]:
        return list(self.roles.get(project_id, {}))

    def list_project_ids_for_member(self, user_id: UUID) -> list[UUID]:
        return [p for p, members in self.roles.items() if user_id in members]


ORGANIZATION_NAMES = {ORG_A: "한국소재연구원", ORG_B: "한빛대학교", ORG_C: "C 기관"}


class FakePeople:
    """DisplayNameLookup backed by USERS."""

    def __init__(self, users: Iterable[CurrentUser] = USERS.values()) -> None:
        users = list(users)
        self._names = {u.user_id: u.display_name for u in users}
        self._orgs = {u.user_id: u.organization_id for u in users}

    def get_display_names(self, user_ids: Sequence[UUID]) -> dict[UUID, str]:
        return {i: self._names[i] for i in user_ids if i in self._names}

    def get_organization_ids(self, user_ids: Sequence[UUID]) -> dict[UUID, UUID]:
        return {i: self._orgs[i] for i in user_ids if i in self._orgs}

    def get_organization_names(self, organization_ids: Sequence[UUID]) -> dict[UUID, str]:
        return {o: ORGANIZATION_NAMES[o] for o in organization_ids if o in ORGANIZATION_NAMES}


def notebook(
    title: str = "고온 구간 용량 분석",
    *cells: NotebookCell,
    saved_at: datetime,
    version_id: UUID | None = None,
) -> NotebookActivity:
    """A saved notebook; by default a markdown goal cell and two code cells."""
    return NotebookActivity(
        notebook_id=new_id(),
        title=title,
        version_id=version_id or new_id(),
        saved_at=saved_at,
        cells=cells
        or (
            NotebookCell("markdown", "## 목표: 40도 이상 고온 구간의 용량 감소를 확인한다", (), 0, False),
            NotebookCell("code", "df = pd.read_csv('cycle.csv')", (), 0, False),
            NotebookCell("code", "df.groupby('temp').capacity.mean().plot()", ("display_data",), 1, False),
        ),
    )


@dataclass
class FakeNotebooks:
    """NotebookActivityPort: (user_id, project_id, day) -> notebooks saved; records every activity lookup."""

    saved: dict[tuple[UUID, UUID, date], list[NotebookActivity]] = field(default_factory=dict)
    calls: list[tuple[UUID, UUID | None, date]] = field(default_factory=list)

    def add(self, user: CurrentUser, project_id: UUID, day: date, *notebooks: NotebookActivity) -> None:
        self.saved.setdefault((user.user_id, project_id, day), []).extend(notebooks)

    def list_notebook_activity(
        self, user_id: UUID, project_id: UUID | None, day: date
    ) -> list[NotebookActivity]:
        self.calls.append((user_id, project_id, day))
        return [
            n
            for (u, p, d), notebooks in self.saved.items()
            if u == user_id and d == day and project_id in (None, p)
            for n in notebooks
        ]

    def list_notebook_authors(self, day: date) -> list[tuple[UUID, UUID]]:
        return sorted({(u, p) for (u, p, d), notebooks in self.saved.items() if d == day and notebooks})


class FakeLlm:
    """LlmClient stand-in (never the network). Each call takes the next scripted answer: a dict is returned, an
    exception is raised, a callable is called with the messages (side effects) and its result used the same way."""

    def __init__(self, *answers: Any) -> None:
        self.answers: list[Any] = list(answers)
        self.calls: list[list[ChatMessage]] = []
        self.max_tokens: list[int] = []

    def script(self, *answers: Any) -> None:
        self.answers = list(answers)

    def chat_json(
        self, messages: list[ChatMessage], *, max_tokens: int = 800, temperature: float = 0.2
    ) -> dict[str, Any]:
        self.calls.append(list(messages))
        self.max_tokens.append(max_tokens)
        if not self.answers:
            raise AssertionError("FakeLlm called more often than scripted")
        answer = self.answers.pop(0)
        if callable(answer) and not isinstance(answer, type):
            answer = answer(messages)
        if isinstance(answer, BaseException) or (
            isinstance(answer, type) and issubclass(answer, BaseException)
        ):
            raise answer
        result: dict[str, Any] = answer
        return result


# Words the fake embedding model "understands": one vector dimension each (a text's vector counts their occurrences).
VOCAB = ("용량", "온도", "전극", "전해질", "수명", "열화")


class FakeEmbedder:
    """EmbeddingClient stand-in (never the network): a bag of VOCAB words, plus a constant dimension so that no
    vector is all zeros. `fail` makes the next calls raise it; `calls` records every batch."""

    def __init__(self) -> None:
        self.calls: list[list[str]] = []
        self.fail: BaseException | None = None
        self.refuse: str | None = None  # a batch with a text containing this is refused (ValueError)

    @staticmethod
    def vector(text: str) -> list[float]:
        return [float(text.count(word)) for word in VOCAB] + [0.1]

    def embed(self, texts: list[str]) -> list[list[float]]:
        self.calls.append(list(texts))
        if self.fail is not None:
            raise self.fail
        if self.refuse is not None and any(self.refuse in t for t in texts):
            raise ValueError("/v1/embeddings: HTTP 400")
        return [self.vector(t) for t in texts]


class FakeReranker:
    """RerankClient stand-in: `score(query, document)` decides; records each call's documents."""

    def __init__(self, score: Any = None) -> None:
        self.score = score or (lambda query, document: 0.5)
        self.calls: list[tuple[str, list[str]]] = []
        self.fail: BaseException | None = None

    def rerank(self, query: str, documents: list[str]) -> list[float]:
        self.calls.append((query, list(documents)))
        if self.fail is not None:
            raise self.fail
        return [float(self.score(query, d)) for d in documents]


JUPYTER_URL = "http://notebook:8888/notebooks"
JUPYTER_TOKEN = "jupyter-test-token"
_CONTENTS = "/notebooks/api/contents"


class FakeJupyter:
    """The Jupyter Server contents API (GET a directory or notebook, PUT a directory) over httpx.MockTransport.
    Notebooks are stored by path with their last_modified; directories are implied by paths or created by PUT.
    `down` makes every request fail to connect; `requests` records every request."""

    def __init__(self, token: str = JUPYTER_TOKEN) -> None:
        self.token = token
        self.notebooks: dict[str, tuple[str, list[dict[str, Any]]]] = {}  # path -> (last_modified, cells)
        self.files: dict[str, str] = {}  # other files: path -> last_modified
        self.dirs: set[str] = set()
        self.down = False
        self.requests: list[httpx.Request] = []

    def add_notebook(self, path: str, last_modified: str, *cells: dict[str, Any]) -> None:
        self.notebooks[path] = (last_modified, list(cells))

    def add_file(self, path: str, last_modified: str = "2026-10-03T01:00:00Z") -> None:
        self.files[path] = last_modified

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self._handle)

    def _is_dir(self, path: str) -> bool:
        if path == "" or path in self.dirs:
            return True
        prefix = path + "/"
        return any(p.startswith(prefix) for p in (*self.notebooks, *self.files, *self.dirs))

    def _children(self, path: str) -> list[dict[str, Any]]:
        prefix = f"{path}/" if path else ""
        seen: dict[str, dict[str, Any]] = {}
        for full in (*self.notebooks, *self.files, *self.dirs):
            if not full.startswith(prefix):
                continue
            name = full[len(prefix) :].split("/", 1)[0]
            child = prefix + name
            if child in self.notebooks:
                entry = {"type": "notebook", "last_modified": self.notebooks[child][0]}
            elif child in self.files:
                entry = {"type": "file", "last_modified": self.files[child]}
            else:
                entry = {"type": "directory", "last_modified": "2026-10-01T00:00:00Z"}
            seen[name] = {"name": name, "path": child, "content": None, "format": None, **entry}
        return [seen[name] for name in sorted(seen)]

    def _handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if self.down:
            raise httpx.ConnectError("connection refused", request=request)
        if request.headers.get("Authorization") != f"token {self.token}":
            return httpx.Response(403, json={"message": "Forbidden"})
        raw = request.url.raw_path.decode().split("?", 1)[0]
        if not raw.startswith(_CONTENTS):
            return httpx.Response(404, json={"message": "Not found"})
        path = unquote(raw[len(_CONTENTS) :]).strip("/")
        if request.method == "PUT":
            self.dirs.add(path)
            return httpx.Response(
                201, json={"name": path.rsplit("/", 1)[-1], "path": path, "type": "directory"}
            )
        if path in self.notebooks:
            last_modified, cells = self.notebooks[path]
            return httpx.Response(
                200,
                json={
                    "name": path.rsplit("/", 1)[-1],
                    "path": path,
                    "type": "notebook",
                    "last_modified": last_modified,
                    "content": {"cells": cells, "metadata": {}, "nbformat": 4, "nbformat_minor": 5},
                },
            )
        if self._is_dir(path):
            return httpx.Response(
                200, json={"name": path, "path": path, "type": "directory", "content": self._children(path)}
            )
        return httpx.Response(404, json={"message": f"No such file or directory: {path}"})
