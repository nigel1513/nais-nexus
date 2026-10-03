"""DisplayNameLookup over M01's public IdentityQueryPort (api.modules.identity.public), the default (empty)
NotebookActivityPort and the shared-Jupyter one (JupyterNotebooks, M07-lite D-049)."""

import logging
from collections.abc import Iterator, Sequence
from datetime import date, datetime, timedelta, timezone
from typing import Any, Literal
from uuid import NAMESPACE_URL, UUID, uuid5

from api.modules.identity.public import IdentityPublicProfile, IdentityQueryPort
from api.modules.notes.interfaces import NotebookActivity, NotebookCell, NotebookSave
from api.platform import ports
from api.platform.errors import ApiError
from api.platform.generated.error_codes import ErrorCode
from api.platform.jupyter import JupyterClient, JupyterSession, JupyterTooLarge


class IdentityDisplayNames:
    """Looks the identity port up per call (wiring order does not matter); unwired -> 503 (fail closed)."""

    @staticmethod
    def _identity() -> IdentityQueryPort:
        try:
            return ports.get(IdentityQueryPort)
        except ports.PortNotProvided as exc:
            raise ApiError(ErrorCode.DEPENDENCY_UNAVAILABLE, "Identity module is not wired.") from exc

    def _profiles(self, user_ids: Sequence[UUID]) -> dict[UUID, IdentityPublicProfile]:
        return self._identity().get_public_profiles(list(dict.fromkeys(user_ids)))

    def get_display_names(self, user_ids: Sequence[UUID]) -> dict[UUID, str]:
        if not user_ids:
            return {}
        return {user_id: p.display_name for user_id, p in self._profiles(user_ids).items()}

    def get_organization_ids(self, user_ids: Sequence[UUID]) -> dict[UUID, UUID]:
        if not user_ids:
            return {}
        return {user_id: p.organization_id for user_id, p in self._profiles(user_ids).items()}

    def get_organization_names(self, organization_ids: Sequence[UUID]) -> dict[UUID, str]:
        if not organization_ids:
            return {}
        identity = self._identity()
        names: dict[UUID, str] = {}
        for organization_id in dict.fromkeys(organization_ids):
            summary = identity.get_organization_summary(organization_id)
            if summary is not None:
                names[organization_id] = summary.name
        return names


class NoNotebooks:
    """NotebookActivityPort until M07 (Jupyter) provides the real one: nobody saved any notebook."""

    def list_notebook_activity(
        self, user_id: UUID, project_id: UUID | None, day: date
    ) -> list[NotebookActivity]:
        return []

    def list_notebook_authors(self, day: date) -> list[tuple[UUID, UUID]]:
        return []

    def count_notebooks(self, user_id: UUID, project_id: UUID, day: date) -> int:
        return 0

    def list_notebook_saves(self, user_id: UUID, project_id: UUID, day: date) -> list[NotebookSave]:
        return []


logger = logging.getLogger("nais.notes")

KST = timezone(timedelta(hours=9), "Asia/Seoul")
WORK = "work"  # the shared Jupyter's work/<user_id>/<project_id>/ folders
MAX_DEPTH = 3  # folders below the project folder that are still walked
MAX_ENTRIES = 200  # directory entries looked at per project folder
MAX_SOURCE_CHARS = 400
DATA_DIR = "data"  # the project's copied inputs (top level only)
CHECKPOINTS = ".ipynb_checkpoints"
# Cell output kinds are read from output_type alone (never data/text/ename/evalue/traceback); anything else is "other".
OUTPUT_KINDS = frozenset({"execute_result", "display_data", "stream", "error", "update_display_data"})


def _uuid_folder(name: Any) -> UUID | None:
    """The UUID a folder is named after, only for canonical (lower-case, hyphenated) UUID names."""
    if not isinstance(name, str):
        return None
    try:
        value = UUID(name)
    except ValueError:
        return None
    return value if str(value) == name else None


def _modified(entry: dict[str, Any]) -> datetime | None:
    raw = entry.get("last_modified")
    if not isinstance(raw, str):
        return None
    try:
        at = datetime.fromisoformat(raw)
    except ValueError:
        return None
    return at if at.tzinfo is not None else None


def _on(at: datetime | None, day: date) -> bool:
    return at is not None and at.astimezone(KST).date() == day


def _source(value: Any) -> str:
    text = "".join(v for v in value if isinstance(v, str)) if isinstance(value, list) else value
    return text[:MAX_SOURCE_CHARS] if isinstance(text, str) else ""


def _cell(raw: Any) -> NotebookCell | None:
    """Source head and output kinds/count/error only: no other key of the cell or its outputs is read."""
    if not isinstance(raw, dict) or raw.get("cell_type") not in ("code", "markdown"):
        return None  # raw cells and junk
    kind: Literal["code", "markdown"] = "code" if raw["cell_type"] == "code" else "markdown"
    outputs = raw.get("outputs") if kind == "code" else None
    types = [o.get("output_type") if isinstance(o, dict) else None for o in outputs or []]
    kinds = [t if t in OUTPUT_KINDS else "other" for t in types]
    return NotebookCell(
        type=kind,
        source_head=_source(raw.get("source")),
        output_kinds=tuple(dict.fromkeys(kinds)),
        output_count=len(kinds),
        has_error="error" in types,
    )


class JupyterNotebooks:
    """NotebookActivityPort over the shared JupyterLab's contents API (api.platform.jupyter.JupyterClient).

    A researcher's notebooks of a project are the .ipynb files under work/<user_id>/<project_id>/ and its folders (at
    most MAX_DEPTH deep, MAX_ENTRIES entries looked at), except the project's data/ (copied inputs) and checkpoints.
    "Saved that day" = last_modified on that day in Asia/Seoul. Folder ids must be canonical UUIDs; the ids passed in
    are UUIDs, so no path is built from free text.

    Every call is one Jupyter session (one HTTP client) with a time budget: activity_budget_s for one researcher's
    activity or count, authors_budget_s for the evening scan of every folder. count_notebooks reads listings only
    (last_modified of the entries); list_notebook_activity also reads the day's notebooks (larger than the client's
    max_bytes are skipped and counted in a log). Jupyter failing or the budget running out raises
    api.platform.jupyter.JupyterUnavailable.
    """

    def __init__(
        self, client: JupyterClient, *, activity_budget_s: float = 5.0, authors_budget_s: float = 30.0
    ) -> None:
        self._client = client
        self.activity_budget_s = activity_budget_s
        self.authors_budget_s = authors_budget_s

    @staticmethod
    def _notebook_entries(session: JupyterSession, folder: str) -> Iterator[dict[str, Any]]:
        """Every notebook entry under the project folder (listings only)."""
        seen = 0
        pending: list[tuple[str, int]] = [(folder, 0)]
        while pending:
            path, depth = pending.pop(0)
            for entry in session.list_dir(path):
                seen += 1
                if seen > MAX_ENTRIES:
                    return
                name = entry.get("name")
                if (
                    not isinstance(name, str)
                    or not name
                    or name.startswith(".")
                    or "/" in name
                    or "\\" in name
                ):
                    continue  # hidden files, checkpoints (.ipynb_checkpoints) and junk
                kind = entry.get("type")
                if kind == "directory":
                    if depth < MAX_DEPTH and not (depth == 0 and name == DATA_DIR):
                        pending.append((f"{path}/{name}", depth + 1))
                elif kind == "notebook" and name.endswith(".ipynb"):
                    yield {**entry, "path": f"{path}/{name}"}

    def _day_paths(self, session: JupyterSession, user_id: UUID, project_id: UUID, day: date) -> list[str]:
        folder = f"{WORK}/{user_id}/{project_id}"
        return [e["path"] for e in self._notebook_entries(session, folder) if _on(_modified(e), day)]

    @staticmethod
    def _projects(session: JupyterSession, user_id: UUID) -> list[UUID]:
        entries = session.list_dir(f"{WORK}/{user_id}")
        found = [_uuid_folder(e.get("name")) for e in entries if e.get("type") == "directory"]
        return [p for p in found if p is not None]

    @staticmethod
    def _activity(session: JupyterSession, path: str) -> NotebookActivity | None:
        model = session.get_notebook(path)
        if model is None:  # deleted between the listing and the read
            return None
        saved_at = _modified(model)
        if saved_at is None:
            return None
        content = model.get("content")
        cells = content.get("cells") if isinstance(content, dict) else None
        name = path.rsplit("/", 1)[-1]
        return NotebookActivity(
            notebook_id=uuid5(NAMESPACE_URL, f"nais-jupyter:{path}"),
            title=name.removesuffix(".ipynb"),
            version_id=None,
            saved_at=saved_at,
            cells=tuple(c for c in map(_cell, cells if isinstance(cells, list) else []) if c is not None),
        )

    def list_notebook_activity(
        self, user_id: UUID, project_id: UUID | None, day: date
    ) -> list[NotebookActivity]:
        out: list[NotebookActivity] = []
        too_large = 0
        with self._client.session(self.activity_budget_s) as session:
            projects = [project_id] if project_id is not None else self._projects(session, user_id)
            for project in projects:
                for path in self._day_paths(session, user_id, project, day):
                    try:
                        activity = self._activity(session, path)
                    except JupyterTooLarge:
                        too_large += 1
                        continue
                    if activity is not None and _on(activity.saved_at, day):
                        out.append(activity)
        if too_large:
            logger.warning("notebooks skipped: too large", extra={"skipped": too_large})
        return out

    def list_notebook_saves(self, user_id: UUID, project_id: UUID, day: date) -> list[NotebookSave]:
        folder = f"{WORK}/{user_id}/{project_id}"
        saves: list[NotebookSave] = []
        with self._client.session(self.activity_budget_s) as session:
            for entry in self._notebook_entries(session, folder):
                at = _modified(entry)
                if at is not None and _on(at, day):
                    saves.append(NotebookSave(entry["path"].rsplit("/", 1)[-1].removesuffix(".ipynb"), at))
        return saves

    def count_notebooks(self, user_id: UUID, project_id: UUID, day: date) -> int:
        return len(self.list_notebook_saves(user_id, project_id, day))

    def list_notebook_authors(self, day: date) -> list[tuple[UUID, UUID]]:
        authors: list[tuple[UUID, UUID]] = []
        with self._client.session(self.authors_budget_s) as session:
            for entry in session.list_dir(WORK):
                user_id = _uuid_folder(entry.get("name")) if entry.get("type") == "directory" else None
                if user_id is None:
                    continue
                for project_id in self._projects(session, user_id):
                    folder = f"{WORK}/{user_id}/{project_id}"
                    if any(_on(_modified(e), day) for e in self._notebook_entries(session, folder)):
                        authors.append((user_id, project_id))
        return authors
