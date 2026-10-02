"""OpenAI-compatible chat, embedding and rerank clients for the shared platform LLM (vLLM)."""

import json
import threading
from dataclasses import dataclass
from typing import Any, Literal, Protocol

import httpx

from api.platform.settings import get_settings

# The GPU is shared with another platform: at most one chat call at a time per process.
_CHAT_SEMAPHORE = threading.Semaphore(1)


class LlmUnavailable(Exception):
    """Timeout, connection failure or 5xx from the LLM platform."""


@dataclass(frozen=True)
class ChatMessage:
    role: Literal["system", "user", "assistant"]
    content: str


class LlmClient(Protocol):
    def chat_json(
        self, messages: list[ChatMessage], *, max_tokens: int = 800, temperature: float = 0.2
    ) -> dict[str, Any]: ...


class EmbeddingClient(Protocol):
    def embed(self, texts: list[str]) -> list[list[float]]: ...


class RerankClient(Protocol):
    def rerank(self, query: str, documents: list[str]) -> list[float]: ...


def _post(
    base_url: str, path: str, payload: dict[str, Any], timeout: float, transport: httpx.BaseTransport | None
) -> Any:
    try:
        with httpx.Client(base_url=base_url.rstrip("/"), timeout=timeout, transport=transport) as client:
            response = client.post(path, json=payload)
    except httpx.HTTPError as exc:  # timeouts, connect/read errors
        raise LlmUnavailable(f"{path}: {exc.__class__.__name__}") from exc
    if response.status_code >= 500:
        raise LlmUnavailable(f"{path}: HTTP {response.status_code}")
    if response.status_code >= 400:
        raise ValueError(f"{path}: HTTP {response.status_code}")
    try:
        return response.json()
    except ValueError as exc:
        raise LlmUnavailable(f"{path}: non-JSON response") from exc


def _first_json_object(text: str) -> dict[str, Any]:
    decoder = json.JSONDecoder()
    start = text.find("{")
    while start != -1:
        try:
            value, _ = decoder.raw_decode(text, start)
        except ValueError:
            start = text.find("{", start + 1)
            continue
        if isinstance(value, dict):
            return value
        start = text.find("{", start + 1)
    raise ValueError("no JSON object in LLM response")


class OpenAiChatClient:
    def __init__(
        self, base_url: str, model: str, timeout_s: float, *, transport: httpx.BaseTransport | None = None
    ) -> None:
        self._base_url, self._model, self._timeout, self._transport = base_url, model, timeout_s, transport

    def chat_json(
        self, messages: list[ChatMessage], *, max_tokens: int = 800, temperature: float = 0.2
    ) -> dict[str, Any]:
        payload = {
            "model": self._model,
            "messages": [{"role": m.role, "content": m.content} for m in messages],
            "max_tokens": max_tokens,
            "temperature": temperature,
        }
        with _CHAT_SEMAPHORE:
            body = _post(self._base_url, "/v1/chat/completions", payload, self._timeout, self._transport)
        try:
            content = body["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError) as exc:
            raise ValueError("unexpected chat completion shape") from exc
        if not isinstance(content, str):
            raise ValueError("chat completion content is not text")
        return _first_json_object(content)


class OpenAiEmbeddingClient:
    def __init__(
        self, base_url: str, model: str, timeout_s: float, *, transport: httpx.BaseTransport | None = None
    ) -> None:
        self._base_url, self._model, self._timeout, self._transport = base_url, model, timeout_s, transport

    def embed(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []
        body = _post(
            self._base_url,
            "/v1/embeddings",
            {"model": self._model, "input": texts},
            self._timeout,
            self._transport,
        )
        try:
            rows = sorted(body["data"], key=lambda row: row.get("index", 0))
            vectors = [[float(x) for x in row["embedding"]] for row in rows]
        except (KeyError, TypeError) as exc:
            raise ValueError("unexpected embeddings shape") from exc
        if len(vectors) != len(texts):
            raise ValueError("embeddings count mismatch")
        return vectors


class HttpRerankClient:
    def __init__(
        self, base_url: str, model: str, timeout_s: float, *, transport: httpx.BaseTransport | None = None
    ) -> None:
        self._base_url, self._model, self._timeout, self._transport = base_url, model, timeout_s, transport

    def rerank(self, query: str, documents: list[str]) -> list[float]:
        if not documents:
            return []
        payload = {"model": self._model, "query": query, "documents": documents}
        body = _post(self._base_url, "/rerank", payload, self._timeout, self._transport)
        scores = [0.0] * len(documents)
        try:
            for row in body["results"]:
                scores[int(row["index"])] = float(row["relevance_score"])
        except (KeyError, TypeError, IndexError) as exc:
            raise ValueError("unexpected rerank shape") from exc
        return scores


def get_llm_client() -> LlmClient | None:
    s = get_settings()
    if not (s.nais_llm_enabled and s.nais_llm_base_url):
        return None
    return OpenAiChatClient(s.nais_llm_base_url, s.nais_llm_model, s.nais_llm_timeout_s)


def get_embedding_client() -> EmbeddingClient | None:
    s = get_settings()
    if not (s.nais_llm_enabled and s.nais_embed_base_url):
        return None
    return OpenAiEmbeddingClient(s.nais_embed_base_url, s.nais_embed_model, s.nais_llm_timeout_s)


def get_rerank_client() -> RerankClient | None:
    s = get_settings()
    if not (s.nais_llm_enabled and s.nais_rerank_base_url):
        return None
    return HttpRerankClient(s.nais_rerank_base_url, s.nais_rerank_model, s.nais_llm_timeout_s)
