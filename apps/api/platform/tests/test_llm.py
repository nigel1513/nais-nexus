import json

import httpx
import pytest

from api.platform import llm
from api.platform.llm import ChatMessage, LlmUnavailable
from api.platform.modules import DEFAULT_MODULE_ORDER
from api.platform.settings import Settings, get_settings

MSGS = [ChatMessage("user", "hi")]


def _chat(content: str) -> dict:
    return {"choices": [{"message": {"role": "assistant", "content": content}}]}


def _client(handler, **kw) -> llm.OpenAiChatClient:
    return llm.OpenAiChatClient("http://llm.test", "llm", 5, transport=httpx.MockTransport(handler), **kw)


def test_chat_json_plain() -> None:
    seen: dict = {}

    def handler(req: httpx.Request) -> httpx.Response:
        seen["url"] = str(req.url)
        seen["body"] = json.loads(req.content)
        return httpx.Response(200, json=_chat('{"a": 1}'))

    assert _client(handler).chat_json(MSGS, max_tokens=50, temperature=0.1) == {"a": 1}
    assert seen["url"] == "http://llm.test/v1/chat/completions"
    assert seen["body"]["model"] == "llm"
    assert seen["body"]["max_tokens"] == 50
    assert seen["body"]["messages"] == [{"role": "user", "content": "hi"}]


def test_chat_json_code_fence_and_prose() -> None:
    content = 'Sure:\n```json\n{"a": {"b": [1, 2]}, "c": "x}"}\n```\nDone'
    client = _client(lambda r: httpx.Response(200, json=_chat(content)))
    assert client.chat_json(MSGS) == {"a": {"b": [1, 2]}, "c": "x}"}


@pytest.mark.parametrize("content", ["not json", '{"a": ', "[1, 2]"])
def test_chat_json_broken_raises_value_error(content: str) -> None:
    client = _client(lambda r: httpx.Response(200, json=_chat(content)))
    with pytest.raises(ValueError):
        client.chat_json(MSGS)


def test_chat_503_and_connect_error_and_timeout() -> None:
    with pytest.raises(LlmUnavailable):
        _client(lambda r: httpx.Response(503)).chat_json(MSGS)

    def boom(req: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("down")

    with pytest.raises(LlmUnavailable):
        _client(boom).chat_json(MSGS)

    def slow(req: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("slow")

    with pytest.raises(LlmUnavailable):
        _client(slow).chat_json(MSGS)


def test_embed_shape() -> None:
    def handler(req: httpx.Request) -> httpx.Response:
        body = json.loads(req.content)
        assert str(req.url) == "http://emb.test/v1/embeddings"
        assert body == {"model": "bge-m3", "input": ["a", "b"]}
        return httpx.Response(
            200, json={"data": [{"index": 1, "embedding": [0.0, 1.0]}, {"index": 0, "embedding": [1.0, 0.0]}]}
        )

    client = llm.OpenAiEmbeddingClient("http://emb.test", "bge-m3", 5, transport=httpx.MockTransport(handler))
    assert client.embed(["a", "b"]) == [[1.0, 0.0], [0.0, 1.0]]
    assert client.embed([]) == []


def test_embed_5xx() -> None:
    client = llm.OpenAiEmbeddingClient(
        "http://emb.test", "m", 5, transport=httpx.MockTransport(lambda r: httpx.Response(500))
    )
    with pytest.raises(LlmUnavailable):
        client.embed(["a"])


def test_rerank_returns_original_order() -> None:
    def handler(req: httpx.Request) -> httpx.Response:
        assert str(req.url) == "http://rr.test/rerank"
        assert json.loads(req.content) == {
            "model": "bge-reranker",
            "query": "q",
            "documents": ["a", "b", "c"],
        }
        return httpx.Response(
            200,
            json={
                "results": [
                    {"index": 2, "relevance_score": 0.9},
                    {"index": 0, "relevance_score": 0.1},
                    {"index": 1, "relevance_score": 0.5},
                ]
            },
        )

    client = llm.HttpRerankClient("http://rr.test", "bge-reranker", 5, transport=httpx.MockTransport(handler))
    assert client.rerank("q", ["a", "b", "c"]) == [0.1, 0.5, 0.9]


def test_rerank_unavailable() -> None:
    client = llm.HttpRerankClient(
        "http://rr.test", "m", 5, transport=httpx.MockTransport(lambda r: httpx.Response(502))
    )
    with pytest.raises(LlmUnavailable):
        client.rerank("q", ["a"])


def _settings(monkeypatch: pytest.MonkeyPatch, **env: str) -> None:
    for key in ("NAIS_LLM_ENABLED", "NAIS_LLM_BASE_URL", "NAIS_EMBED_BASE_URL", "NAIS_RERANK_BASE_URL"):
        monkeypatch.delenv(key, raising=False)
    for key, value in env.items():
        monkeypatch.setenv(key, value)
    get_settings.cache_clear()


def test_factories_disabled_return_none(monkeypatch: pytest.MonkeyPatch) -> None:
    _settings(
        monkeypatch,
        NAIS_EMBED_BASE_URL="http://e",
        NAIS_RERANK_BASE_URL="http://r",
        NAIS_LLM_BASE_URL="http://l",
    )
    try:
        assert llm.get_llm_client() is None
        assert llm.get_embedding_client() is None
        assert llm.get_rerank_client() is None
    finally:
        get_settings.cache_clear()


def test_factories_enabled(monkeypatch: pytest.MonkeyPatch) -> None:
    _settings(
        monkeypatch, NAIS_LLM_ENABLED="true", NAIS_LLM_BASE_URL="http://l", NAIS_EMBED_BASE_URL="http://e"
    )
    try:
        assert llm.get_llm_client() is not None
        assert llm.get_embedding_client() is not None
        assert llm.get_rerank_client() is None  # base url unset
    finally:
        get_settings.cache_clear()


def test_factory_llm_enabled_without_base_url(monkeypatch: pytest.MonkeyPatch) -> None:
    _settings(monkeypatch, NAIS_LLM_ENABLED="true")
    try:
        assert llm.get_llm_client() is None
    finally:
        get_settings.cache_clear()


def test_settings_defaults() -> None:
    s = Settings(_env_file=None)
    assert (s.nais_llm_enabled, s.nais_llm_model, s.nais_llm_timeout_s) == (False, "llm", 60)
    assert (s.nais_embed_model, s.nais_rerank_model) == ("bge-m3", "bge-reranker")


def test_chat_calls_are_serialized() -> None:
    import threading
    import time

    active = 0
    peak = 0
    lock = threading.Lock()

    def handler(req: httpx.Request) -> httpx.Response:
        nonlocal active, peak
        with lock:
            active += 1
            peak = max(peak, active)
        time.sleep(0.05)
        with lock:
            active -= 1
        return httpx.Response(200, json=_chat("{}"))

    client = _client(handler)
    threads = [threading.Thread(target=client.chat_json, args=(MSGS,)) for _ in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert peak == 1


def test_workspace_and_notes_registered_between_project_and_audit() -> None:
    order = list(DEFAULT_MODULE_ORDER)
    assert order.index("catalog") < order.index("workspace") < order.index("notes") < order.index("audit")


def test_chat_cut_at_max_tokens_raises_llm_truncated() -> None:
    """finish_reason "length": the answer was cut off (LlmTruncated, a ValueError, so older callers still see it)."""
    body = {"choices": [{"message": {"role": "assistant", "content": '{"a": 1}'}, "finish_reason": "length"}]}
    with pytest.raises(llm.LlmTruncated):
        _client(lambda r: httpx.Response(200, json=body)).chat_json(MSGS)
    assert issubclass(llm.LlmTruncated, ValueError)
    done = {"choices": [{"message": {"role": "assistant", "content": '{"a": 1}'}, "finish_reason": "stop"}]}
    assert _client(lambda r: httpx.Response(200, json=done)).chat_json(MSGS) == {"a": 1}
