"""The shared JupyterLab's REST contents API (M07-lite, D-049): list a directory, read a notebook, create a directory.

Jupyter Server under base URL NAIS_JUPYTER_URL (e.g. http://notebook:8888/notebooks), one shared token
NAIS_JUPYTER_TOKEN sent as `Authorization: token ...` (never logged). Paths are relative to the server root
(`work/<user_id>/<project_id>/...`); a path with empty, `.` or `..` segments, a leading slash or a backslash is refused
before any request. Network errors, timeouts, refused tokens, 5xx and non-JSON answers raise JupyterUnavailable; a
missing path is an empty listing / None.
"""

from typing import Any
from urllib.parse import quote

import httpx

from api.platform.settings import Settings, get_settings

TIMEOUT_S = 10.0


class JupyterUnavailable(RuntimeError):  # noqa: N818
    pass


def _safe(path: str) -> str:
    """The URL-encoded relative path; ValueError for anything that could leave the intended folder."""
    if path == "":
        return ""
    segments = path.split("/")
    if "\\" in path or any(s in ("", ".", "..") for s in segments):
        raise ValueError("unsafe Jupyter path")
    return "/".join(quote(s, safe="") for s in segments)


class JupyterClient:
    def __init__(
        self,
        base_url: str,
        token: str,
        *,
        timeout: float = TIMEOUT_S,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self._base = base_url.rstrip("/")
        self._headers = {"Authorization": f"token {token}"}
        self._timeout = timeout
        self._transport = transport

    def _url(self, path: str) -> str:
        return f"{self._base}/api/contents/{_safe(path)}"

    def _request(self, method: str, path: str, **kwargs: Any) -> httpx.Response:
        url = self._url(path)
        try:
            with httpx.Client(timeout=self._timeout, transport=self._transport) as client:
                return client.request(method, url, headers=self._headers, **kwargs)
        except httpx.HTTPError as exc:
            raise JupyterUnavailable(f"jupyter {method}: {exc.__class__.__name__}") from exc

    @staticmethod
    def _json(response: httpx.Response) -> dict[str, Any]:
        if response.status_code >= 300:
            raise JupyterUnavailable(f"jupyter {response.request.method} -> HTTP {response.status_code}")
        try:
            body = response.json()
        except ValueError as exc:
            raise JupyterUnavailable("jupyter: non-JSON response") from exc
        if not isinstance(body, dict):
            raise JupyterUnavailable("jupyter: unexpected response shape")
        return body

    def _get(self, path: str) -> dict[str, Any] | None:
        response = self._request("GET", path, params={"content": "1"})
        if response.status_code == 404:
            return None
        return self._json(response)

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
            self._json(self._request("PUT", "/".join(segments[:depth]), json={"type": "directory"}))


def get_jupyter_client(settings: Settings | None = None) -> JupyterClient | None:
    """None while NAIS_JUPYTER_URL is unset."""
    s = settings or get_settings()
    if not s.nais_jupyter_url:
        return None
    return JupyterClient(s.nais_jupyter_url, s.nais_jupyter_token)
