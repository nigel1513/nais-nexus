"""Full reindex into a new versioned index, then an atomic alias swap (M03 §10 catalog.reindex_all).

Run: python -m api.modules.catalog.reindex
"""

from collections.abc import Sequence
from uuid import UUID

from sqlalchemy import select

from api.modules.catalog.deps import CatalogDeps
from api.modules.catalog.repo import enqueue_index
from api.modules.catalog.search.documents import build_documents, embed_documents
from api.modules.catalog.tables import datasets


def reindex_all(deps: CatalogDeps, *, chunk: int = 200) -> str:
    index = deps.search
    index.ensure()
    new_index = index.next_index_name()
    index.create_index(new_index, exist_ok=False)
    vectors = deps.embedder is not None and index.supports_vectors(new_index)
    with deps.session_factory() as session:
        ids: list[UUID] = list(
            session.execute(select(datasets.c.dataset_id).order_by(datasets.c.dataset_id)).scalars()
        )
        for start in range(0, len(ids), chunk):
            docs, _ = build_documents(session, deps.organizations, ids[start : start + chunk])
            if vectors:
                embed_documents(docs, deps.embedder)
            index.bulk(docs, [], index=new_index)
    index.swap_alias(new_index)
    # Changes committed while we were loading went to the old index: queue everything once more.
    with deps.session_factory() as session, session.begin():
        # Re-select: datasets created during the load are in neither the new index nor the snapshot.
        current: list[UUID] = list(session.execute(select(datasets.c.dataset_id)).scalars())
        for dataset_id in current:
            enqueue_index(session, dataset_id)
    return new_index


def main(argv: Sequence[str] | None = None) -> int:
    from api.modules.catalog.wiring import build_default_deps
    from api.platform.broker import configure_broker
    from api.platform.logs import configure_logging
    from api.platform.modules import discover_modules
    from api.platform.settings import get_settings

    settings = get_settings()
    configure_logging(settings.log_level)
    configure_broker(settings)
    # Search documents carry people and organization names, so the identity port must be provided.
    for spec in discover_modules():
        if spec.wire is not None:
            spec.wire()
    deps = build_default_deps()
    print(f"alias {deps.search.alias} -> {reindex_all(deps)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
