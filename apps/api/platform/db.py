from collections.abc import Iterator
from contextlib import contextmanager
from functools import lru_cache

from sqlalchemy import Engine, create_engine
from sqlalchemy.orm import Session, sessionmaker

from api.platform.settings import get_settings


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


def get_session() -> Iterator[Session]:
    """FastAPI dependency: one transaction per request, rolled back on any error."""
    with session_scope() as session:
        yield session
