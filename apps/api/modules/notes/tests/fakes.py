"""In-memory stand-ins for the ports the notes module consumes (project membership, display names)."""

from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from typing import Any
from uuid import UUID

from nais_contracts.api_models import ProjectSummary

from api.platform.auth import CurrentUser
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


class FakePeople:
    """DisplayNameLookup backed by USERS."""

    def __init__(self, users: Iterable[CurrentUser] = USERS.values()) -> None:
        self._names = {u.user_id: u.display_name for u in users}

    def get_display_names(self, user_ids: Sequence[UUID]) -> dict[UUID, str]:
        return {i: self._names[i] for i in user_ids if i in self._names}


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

    @staticmethod
    def vector(text: str) -> list[float]:
        return [float(text.count(word)) for word in VOCAB] + [0.1]

    def embed(self, texts: list[str]) -> list[list[float]]:
        self.calls.append(list(texts))
        if self.fail is not None:
            raise self.fail
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
