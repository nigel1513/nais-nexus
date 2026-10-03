"""One drafting pass shared by the `notes.draft_note` job and draftInternalNoteSections (D-049): the day's notebooks ->
prompt (prompt.py) -> local LLM -> policed sentences (parse.py). An unusable answer (ValueError) is asked again once,
then UnusableAnswer; LlmUnavailable and LlmTruncated propagate at once (the caller decides what failing means)."""

import logging
from collections.abc import Iterable, Sequence
from datetime import date
from typing import Any

from api.modules.notes.drafting.parse import DraftSentence, parse_draft
from api.modules.notes.drafting.prompt import PromptItem, build_messages, notebooks, plan
from api.platform.llm import ChatMessage, LlmClient, LlmTruncated, LlmUnavailable

logger = logging.getLogger("nais.notes")

MAX_ATTEMPTS = 2  # an unusable answer is asked again once
# 7 sections x 6 sentences x 120 Korean characters inside JSON (~1 token per Hangul syllable plus keys/indexes); in
# practice far fewer sections are filled.
MAX_TOKENS = 3584


class UnusableAnswer(Exception):  # noqa: N818
    """Every attempt answered something parse_draft could not use."""


def prepare(day: date, source: Iterable[Any]) -> tuple[list[PromptItem], list[ChatMessage]]:
    """The numbered prompt items and the chat messages for the notebooks (NotebookActivityPort answer) of a day."""
    prompt = plan(notebooks(source))
    return prompt.items, build_messages(day, prompt)


def ask(
    llm: LlmClient, messages: list[ChatMessage], items: Sequence[PromptItem], log: dict[str, Any]
) -> list[DraftSentence]:
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            answer = llm.chat_json(messages, max_tokens=MAX_TOKENS)
            return parse_draft(answer, items)
        except (LlmUnavailable, LlmTruncated):  # LlmTruncated is a ValueError: never asked again
            raise
        except ValueError as exc:  # the answer may quote the prompt: log the type only
            logger.warning(
                "unusable LLM answer", extra=log | {"attempt": attempt, "error_type": type(exc).__name__}
            )
    raise UnusableAnswer
