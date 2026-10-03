"""The shared JupyterLab's REST contents API (M07-lite, D-049): list a directory, read a notebook, create a directory.

Jupyter Server under base URL NAIS_JUPYTER_URL (e.g. http://notebook:8888/notebooks), one shared token
NAIS_JUPYTER_TOKEN sent as `Authorization: token ...` (never logged). Paths are relative to the server root
(`work/<user_id>/<project_id>/...`); a path with empty, `.` or `..` segments, a leading slash or a backslash is refused
before any request.

Work happens in a session (`JupyterClient.session(budget_s)`): one httpx.Client (connections reused) and one monotonic
deadline checked before every request; each request waits at most min(timeout, time left). A spent budget, network
errors, timeouts, refused tokens (401/403), 5xx and non-JSON answers raise JupyterUnavailable; a missing path is an empty
listing / None; an answer over max_bytes (default 20 MiB, read streamed) raises JupyterTooLarge.

httpx logs every request at INFO on the shared "httpx" logger; a filter on that logger drops those below-WARNING records
for Jupyter URLs only (other clients' request logs are unchanged).
"""

import json
import logging
import time
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any
from urllib.parse import quote

import httpx

from api.platform.settings import Settings, get_settings

TIMEOUT_S = 10.0
MAX_BYTES = 20 * 1024 * 1024  # one answer (a notebook with its outputs and images, or a listing)


class JupyterUnavailable(RuntimeError):  # noqa: N818
    pass


class JupyterTooLarge(RuntimeError):  # noqa: N818
    """The answer is larger than max_bytes (the caller skips that notebook)."""


class _QuietJupyterRequests(logging.Filter):
    """Drops the "httpx" logger's below-WARNING records about requests to the Jupyter base URLs."""

    def __init__(self) -> None:
        super().__init__()
        self.bases: set[str] = set()

    def filter(self, record: logging.LogRecord) -> bool:
        if record.levelno >= logging.WARNING:
            return True
        args = record.args if isinstance(record.args, tuple) else ()
        return not any(str(a).startswith(base) for a in args for base in self.bases)


_QUIET = _QuietJupyterRequests()
logging.getLogger("httpx").addFilter(_QUIET)


def _safe(path: str) -> str:
    """The URL-encoded relative path; ValueError for anything that could leave the intended folder."""
    if path == "":
        return ""
    segments = path.split("/")
    if "\\" in path or any(s in ("", ".", "..") for s in segments):
        raise ValueError("unsafe Jupyter path")
    return "/".join(quote(s, safe="") for s in segments)


class JupyterSession:
    """One unit of work: one HTTP client, one deadline."""

    def __init__(
        self,
        http: httpx.Client,
        base: str,
        headers: dict[str, str],
        timeout: float,
        deadline: float,
        max_bytes: int,
    ) -> None:
        self._http = http
        self._base = base
        self._headers = headers
        self._timeout = timeout
        self._deadline = deadline
        self._max_bytes = max_bytes

    def _time_left(self) -> float:
        left = self._deadline - time.monotonic()
        if left <= 0:
            raise JupyterUnavailable("jupyter: time budget spent")
        return min(self._timeout, left)

    def _url(self, path: str) -> str:
        return f"{self._base}/api/contents/{_safe(path)}"

    @staticmethod
    def _check(status: int, method: str) -> None:
        if status >= 300:
            raise JupyterUnavailable(f"jupyter {method} -> HTTP {status}")

    def _read(self, response: httpx.Response) -> bytes:
        declared = response.headers.get("Content-Length", "")
        if declared.isdigit() and int(declared) > self._max_bytes:
            raise JupyterTooLarge(f"{declared} bytes")
        chunks: list[bytes] = []
        size = 0
        for chunk in response.iter_bytes():
            size += len(chunk)
            if size > self._max_bytes:
                raise JupyterTooLarge(f"over {self._max_bytes} bytes")
            chunks.append(chunk)
        return b"".join(chunks)

    def _get(self, path: str) -> dict[str, Any] | None:
        url = self._url(path)
        timeout = self._time_left()
        try:
            with self._http.stream(
                "GET", url, params={"content": "1"}, headers=self._headers, timeout=timeout
            ) as response:
                if response.status_code == 404:
                    return None
                self._check(response.status_code, "GET")
                raw = self._read(response)
        except httpx.HTTPError as exc:
            raise JupyterUnavailable(f"jupyter GET: {exc.__class__.__name__}") from exc
        try:
            body = json.loads(raw)
        except ValueError as exc:
            raise JupyterUnavailable("jupyter: non-JSON response") from exc
        if not isinstance(body, dict):
            raise JupyterUnavailable("jupyter: unexpected response shape")
        return body

    def list_dir(self, path: str) -> list[dict[str, Any]]:
        """The directory's entries ({name, path, type, last_modified, ...}); [] when it does not exist."""
        model = self._get(path)
        if model is None or model.get("type") != "directory":
            return []
        content = model.get("content")
        return [e for e in content if isinstance(e, dict)] if isinstance(content, list) else []

    def get_notebook(self, path: str) -> dict[str, Any] | None:
        """The notebook model ({type: notebook, last_modified, content: {cells}}); None when it does not exist."""
        model = self._get(path)
        if model is None or model.get("type") != "notebook":
            return None
        return model

    def ensure_dir(self, path: str) -> None:
        """Create the directory and every missing parent (PUT of an existing directory is a no-op)."""
        _safe(path)
        segments = path.split("/")
        for depth in range(1, len(segments) + 1):
            url = self._url("/".join(segments[:depth]))
            timeout = self._time_left()
            try:
                response = self._http.put(
                    url, json={"type": "directory"}, headers=self._headers, timeout=timeout
                )
            except httpx.HTTPError as exc:
                raise JupyterUnavailable(f"jupyter PUT: {exc.__class__.__name__}") from exc
            self._check(response.status_code, "PUT")


class JupyterClient:
    def __init__(
        self,
        base_url: str,
        token: str,
        *,
        timeout: float = TIMEOUT_S,
        max_bytes: int = MAX_BYTES,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self._base = base_url.rstrip("/")
        self._headers = {"Authorization": f"token {token}"}
        self._timeout = timeout
        self._max_bytes = max_bytes
        self._transport = transport
        _QUIET.bases.add(self._base)

    @contextmanager
    def session(self, budget_s: float | None = None) -> Iterator[JupyterSession]:
        """One connection pool and one deadline (default: one request timeout) for a unit of work."""
        deadline = time.monotonic() + (budget_s if budget_s is not None else self._timeout)
        with httpx.Client(timeout=self._timeout, transport=self._transport) as http:
            yield JupyterSession(http, self._base, self._headers, self._timeout, deadline, self._max_bytes)

    def list_dir(self, path: str) -> list[dict[str, Any]]:
        with self.session() as session:
            return session.list_dir(path)

    def get_notebook(self, path: str) -> dict[str, Any] | None:
        with self.session() as session:
            return session.get_notebook(path)

    def ensure_dir(self, path: str, budget_s: float = 30.0) -> None:
        _safe(path)
        with self.session(budget_s) as session:
            session.ensure_dir(path)


def get_jupyter_client(settings: Settings | None = None) -> JupyterClient | None:
    """None while NAIS_JUPYTER_URL is unset."""
    s = settings or get_settings()
    if not s.nais_jupyter_url:
        return None
    return JupyterClient(s.nais_jupyter_url, s.nais_jupyter_token)
