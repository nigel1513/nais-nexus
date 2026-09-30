from collections.abc import Iterator
from contextlib import contextmanager
from functools import lru_cache
from typing import Annotated

from fastapi import Depends, Request
from sqlalchemy import Engine, create_engine
from sqlalchemy.orm import Session, sessionmaker

from api.platform.settings import Settings, get_settings


@lru_cache(maxsize=8)
def engine_for(url: str) -> Engine:
    return create_engine(url, pool_pre_ping=True, connect_args={"connect_timeout": 2})


def session_factory(url: str | None = None) -> sessionmaker[Session]:
    return sessionmaker(bind=engine_for(url or get_settings().database_url), expire_on_commit=False)


@contextmanager
def session_scope(url: str | None = None) -> Iterator[Session]:
    session = session_factory(url)()
    try:
        yield session
        session.commit()
    except BaseException:
        session.rollback()
        raise
    finally:
        session.close()


def get_session(request: Request) -> Iterator[Session]:
    """One transaction per request, rolled back on any error. Use it through SessionDep."""
    settings: Settings = getattr(request.app.state, "settings", None) or get_settings()
    with session_scope(settings.database_url) as session:
        yield session


SessionDep = Annotated[Session, Depends(get_session, scope="function")]
"""THE way endpoints get a DB session. scope="function" commits BEFORE the response is built, so a failed
commit (e.g. a deferred constraint) becomes a 500 error envelope instead of an already-sent 2xx."""
