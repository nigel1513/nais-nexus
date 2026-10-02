"""ModuleSpec.seed (10_SEED_DATA §1 step 3): datasets -> versions -> files -> S3 objects -> publish -> index queue."""

import hashlib
import logging

from sqlalchemy import insert
from sqlalchemy.orm import Session

from api.modules.catalog.deps import CatalogDeps
from api.modules.catalog.domain import ALLOWED_MEDIA_TYPES, build_policy, extension, storage_key
from api.modules.catalog.repo import load_dataset, load_version, must
from api.modules.catalog.seed_data import ORG_CODES, SEED_DATASETS, SeedDataset, file_id, metadata_for
from api.modules.catalog.seed_files import fixture_files
from api.modules.catalog.service.datasets import insert_dataset
from api.modules.catalog.service.publish import finalize_publish
from api.modules.catalog.tables import dataset_files, dataset_versions, upload_sessions
from api.platform import clock, ports
from api.platform.events import EventActor

logger = logging.getLogger("nais.catalog.seed")


def _deps() -> CatalogDeps:
    try:
        return ports.get(CatalogDeps)
    except ports.PortNotProvided:  # `python -m api.platform.cli seed` does not call wire()
        from api.modules.catalog.wiring import build_default_deps

        return build_default_deps()


def _seed_one(session: Session, deps: CatalogDeps, item: SeedDataset) -> None:
    actor = EventActor(type="USER", user_id=item.steward, organization_id=item.owner)
    policy = build_policy(item.access_level, item.allowed_purposes, item.max_grant_days)
    fields = {"title": item.title, **metadata_for(item.fixture)}
    insert_dataset(
        session,
        dataset_id=item.dataset_id,
        owner=item.owner,
        created_by=item.steward,
        fields=fields,
        policy=policy,
        actor=actor,
    )
    now = clock.now()
    session.execute(
        insert(dataset_versions).values(
            dataset_version_id=item.version_id,
            dataset_id=item.dataset_id,
            version_label="v1",
            status="DRAFT",
            change_note="Seed data (10_SEED_DATA.md)",
            created_by=item.steward,
            created_at=now,
            updated_at=now,
        )
    )
    if item.fixture is None:
        return
    store = deps.storage.for_org(ORG_CODES[item.owner])
    session.execute(
        insert(upload_sessions).values(
            upload_session_id=item.session_id,
            dataset_version_id=item.version_id,
            status="COMPLETED",
            created_by=item.steward,
            expires_at=now,
            completed_at=now,
            created_at=now,
        )
    )
    for path, data in sorted(fixture_files(item.fixture).items()):
        key = storage_key(item.dataset_id, item.version_id, item.session_id, path)
        media_type = ALLOWED_MEDIA_TYPES[extension(path)]
        store.put(key, data, media_type)
        session.execute(
            insert(dataset_files).values(
                file_id=file_id(item.version_id, path),
                dataset_version_id=item.version_id,
                upload_session_id=item.session_id,
                path=path,
                size_bytes=len(data),
                sha256=hashlib.sha256(data).hexdigest(),
                media_type=media_type,
                storage_bucket=store.bucket,
                storage_key=key,
                status="VERIFIED",
                scan_status="SKIPPED",
                verified_at=now,
                created_at=now,
                updated_at=now,
            )
        )
    if item.publish:
        finalize_publish(
            session,
            ds=must(load_dataset(session, item.dataset_id), "dataset"),
            version=must(load_version(session, item.version_id), "version"),
            published_by=item.steward,
            actor=actor,
            deps=deps,
        )


def seed(session: Session) -> None:
    deps = _deps()
    for item in SEED_DATASETS:
        if load_dataset(session, item.dataset_id) is not None:
            continue
        _seed_one(session, deps, item)
        logger.info("seeded dataset", extra={"dataset_id": str(item.dataset_id), "title": item.title})
