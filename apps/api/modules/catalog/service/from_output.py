"""CatalogPublishPort (M13 output publication): a project output approved by the owner organizations of its inputs
becomes a catalog dataset through the catalog's own rules.

1. One transaction: dataset (owner = the output's storage organization, provenance = lineage note, catalog.dataset.
   created.v1), DRAFT version v1 and a server-side upload session (created COMPLETED: there is no client upload
   window for the expiry sweep to close) with PENDING file rows under the normal storage layout (D-039).
2. Each PENDING file: server-side copy of the output object into its catalog key, size check -> UPLOADED / FAILED
   (the same outcomes completeUploadSession records).
3. Verification exactly as completeUploadSession: synchronous below catalog_sync_verify_max_bytes, the verify queue
   otherwise (the verify job and the stale re-queue sweep then own those files).
4. Once every file is VERIFIED: finalize_publish (manifest + snapshot + catalog.dataset.version_published.v1, which
   starts readiness and previews like any publish).

Idempotent on dataset_id: a later call resumes at whichever step the previous one reached. The caller serializes
calls for one dataset_id (the workspace holds a lease per publish request).
"""

import logging
from collections.abc import Sequence
from uuid import UUID

from sqlalchemy import insert, select, update
from sqlalchemy.engine import RowMapping
from sqlalchemy.orm import Session

from api.modules.catalog.deps import CatalogDeps
from api.modules.catalog.domain import (
    MAX_FILE_BYTES,
    MAX_FILES_PER_VERSION,
    InvalidPolicy,
    Policy,
    build_policy,
    canonical_media_type,
    media_type_allowed,
    path_problem,
    storage_key,
)
from api.modules.catalog.objects import ObjectMissing, ObjectStore
from api.modules.catalog.objects import StorageUnavailable as InternalStorageUnavailable
from api.modules.catalog.public import (
    AccessLevel,
    CatalogPublishRejected,
    OutputDatasetState,
    OutputFileSource,
    StorageUnavailable,
)
from api.modules.catalog.repo import load_dataset, load_version, must
from api.modules.catalog.service.datasets import insert_dataset
from api.modules.catalog.service.publish import finalize_publish
from api.modules.catalog.tables import dataset_files, dataset_versions, upload_sessions
from api.modules.catalog.verification import verify_in_session
from api.platform import clock
from api.platform.events import EventActor
from api.platform.ids import new_id
from api.platform.storage import StorageNotConfigured

logger = logging.getLogger("nais.catalog.from_output")

VERSION_LABEL = "v1"
CHANGE_NOTE = "프로젝트 산출물에서 공개"
DERIVED_LICENSE = "원본 데이터셋의 라이선스를 따름 (파생 데이터)"


class CatalogOutputPublisher:
    def __init__(self, deps: CatalogDeps) -> None:
        self._deps = deps

    # ------------------------------------------------------------ validation

    def output_file_problems(self, files: Sequence[OutputFileSource]) -> list[dict[str, str]]:
        problems: list[dict[str, str]] = []
        if not files:
            problems.append({"path": "", "reason": "NO_FILES"})
        if len(files) > MAX_FILES_PER_VERSION:
            problems.append({"path": "", "reason": "TOO_MANY_FILES"})
        seen: set[str] = set()
        for f in files:
            reason = path_problem(f.path)
            if reason is None and f.path in seen:
                reason = "DUPLICATE_PATH"
            seen.add(f.path)
            if reason is None and not media_type_allowed(f.path, f.media_type):
                reason = "FILE_TYPE_NOT_ALLOWED"
            if reason is None and not 1 <= f.size_bytes <= MAX_FILE_BYTES:
                reason = "FILE_TOO_LARGE" if f.size_bytes > MAX_FILE_BYTES else "EMPTY_FILE"
            if reason is not None:
                problems.append({"path": f.path, "reason": reason})
        return problems

    # ------------------------------------------------------------ creation

    def create_dataset_from_output(
        self,
        *,
        dataset_id: UUID,
        owner_organization_id: UUID,
        title: str,
        description: str,
        access_level: AccessLevel,
        allowed_purposes: Sequence[str],
        files: Sequence[OutputFileSource],
        lineage_note: str,
        created_by: UUID,
        published_by: UUID,
        publisher_organization_id: UUID | None,
    ) -> OutputDatasetState:
        deps = self._deps
        problems = self.output_file_problems(files)
        if problems:
            raise CatalogPublishRejected(f"files break the catalog upload rules: {problems}")
        org = deps.organizations.get_organization_summary(owner_organization_id)
        if org is None or not deps.storage.is_configured(org.code):
            raise CatalogPublishRejected("the owner organization has no storage configured")
        if any(f.storage_org_code != org.code for f in files):
            raise CatalogPublishRejected("the output objects are not in the owner organization's storage")
        try:
            policy = build_policy(access_level, allowed_purposes, None)
        except InvalidPolicy as exc:
            raise CatalogPublishRejected(str(exc)) from exc
        actor = EventActor(type="USER", user_id=published_by, organization_id=publisher_organization_id)
        sources = {f.path: f for f in files}
        try:
            store = deps.storage.for_org(org.code)
            with deps.session_factory() as session, session.begin():
                version = self._ensure_draft(
                    session,
                    store,
                    dataset_id=dataset_id,
                    owner=owner_organization_id,
                    title=title,
                    description=description,
                    lineage_note=lineage_note,
                    policy_args=policy,
                    created_by=created_by,
                    files=files,
                    actor=actor,
                )
            version_id = version["dataset_version_id"]
            if version["status"] == "DRAFT":
                self._verify(self._copy_pending(store, version_id, sources))
                return self._publish_if_ready(dataset_id, version_id, published_by, actor)
        except InternalStorageUnavailable as exc:
            raise StorageUnavailable(str(exc)) from exc
        except StorageNotConfigured as exc:
            raise CatalogPublishRejected(str(exc)) from exc
        return OutputDatasetState(dataset_id, version_id, "PUBLISHED")

    def _ensure_draft(
        self,
        session: Session,
        store: ObjectStore,
        *,
        dataset_id: UUID,
        owner: UUID,
        title: str,
        description: str,
        lineage_note: str,
        policy_args: Policy,
        created_by: UUID,
        files: Sequence[OutputFileSource],
        actor: EventActor,
    ) -> RowMapping:
        """The dataset's v1 (created with its PENDING files on the first call)."""
        ds = load_dataset(session, dataset_id, for_update=True)
        if ds is not None:
            version = (
                session.execute(
                    select(dataset_versions).where(
                        dataset_versions.c.dataset_id == dataset_id,
                        dataset_versions.c.version_label == VERSION_LABEL,
                    )
                )
                .mappings()
                .first()
            )
            if ds["owner_organization_id"] != owner or version is None:
                raise CatalogPublishRejected("dataset_id is already used by another dataset")
            return version
        insert_dataset(
            session,
            dataset_id=dataset_id,
            owner=owner,
            created_by=created_by,
            fields={
                "title": title,
                "description": description,
                "license": DERIVED_LICENSE,
                "provenance": lineage_note,
            },
            policy=policy_args,
            actor=actor,
        )
        now = clock.now()
        version_id = new_id()
        session.execute(
            insert(dataset_versions).values(
                dataset_version_id=version_id,
                dataset_id=dataset_id,
                version_label=VERSION_LABEL,
                status="DRAFT",
                change_note=CHANGE_NOTE,
                created_by=created_by,
                created_at=now,
                updated_at=now,
            )
        )
        upload_session_id = new_id()
        session.execute(
            insert(upload_sessions).values(
                upload_session_id=upload_session_id,
                dataset_version_id=version_id,
                status="COMPLETED",
                created_by=created_by,
                expires_at=now,
                completed_at=now,
                created_at=now,
            )
        )
        session.execute(
            insert(dataset_files),
            [
                {
                    "file_id": new_id(),
                    "dataset_version_id": version_id,
                    "upload_session_id": upload_session_id,
                    "path": f.path,
                    "size_bytes": f.size_bytes,
                    "sha256": f.sha256,
                    "media_type": canonical_media_type(f.media_type),
                    "storage_bucket": store.bucket,
                    "storage_key": storage_key(dataset_id, version_id, upload_session_id, f.path),
                    "multipart_upload_id": None,
                    "part_size_bytes": None,
                    "status": "PENDING",
                    "failure_code": None,
                    "scan_status": "SKIPPED",
                    "verified_at": None,
                    "created_at": now,
                    "updated_at": now,
                }
                for f in files
            ],
        )
        return must(load_version(session, version_id), "version")

    def _copy_pending(
        self, store: ObjectStore, version_id: UUID, sources: dict[str, OutputFileSource]
    ) -> list[RowMapping]:
        """PENDING -> UPLOADED (copied, size matches) or FAILED; returns the rows that became UPLOADED.
        No transaction is held while copying."""
        with self._deps.session_factory() as session:
            pending = (
                session.execute(
                    select(dataset_files)
                    .where(
                        dataset_files.c.dataset_version_id == version_id, dataset_files.c.status == "PENDING"
                    )
                    .order_by(dataset_files.c.path.collate("C"))
                )
                .mappings()
                .all()
            )
        uploaded: list[RowMapping] = []
        for f in pending:
            source = sources.get(f["path"])
            if source is None:
                raise CatalogPublishRejected("the files differ from the ones the dataset was created with")
            status, failure = _copy(store, source.storage_key, f)
            with self._deps.session_factory() as session, session.begin():
                _lock_version(session, version_id)
                changed = session.execute(
                    update(dataset_files)
                    .where(dataset_files.c.file_id == f["file_id"], dataset_files.c.status == "PENDING")
                    .values(status=status, failure_code=failure, updated_at=clock.now())
                ).rowcount  # type: ignore[attr-defined]
            if changed == 1 and status == "UPLOADED":
                uploaded.append(f)
        return uploaded

    def _verify(self, uploaded: Sequence[RowMapping]) -> None:
        """completeUploadSession's rule: small sets now (storage/scanner trouble defers to the worker), else queued."""
        deps = self._deps
        if not uploaded:
            return
        deferred: list[UUID] = []
        if sum(int(f["size_bytes"]) for f in uploaded) <= deps.settings.catalog_sync_verify_max_bytes:
            with deps.session_factory() as session, session.begin():
                _lock_version(session, uploaded[0]["dataset_version_id"])
                for f in uploaded:
                    try:
                        with session.begin_nested():
                            verify_in_session(session, deps, f)
                    except Exception:
                        logger.warning(
                            "sync verification failed; deferring to worker",
                            extra={"file_id": str(f["file_id"])},
                            exc_info=True,
                        )
                        deferred.append(f["file_id"])
        else:
            deferred = [f["file_id"] for f in uploaded]
        if deferred:
            deps.verification.enqueue(deferred)

    def _publish_if_ready(
        self, dataset_id: UUID, version_id: UUID, published_by: UUID, actor: EventActor
    ) -> OutputDatasetState:
        deps = self._deps
        with deps.session_factory() as session, session.begin():
            # Lock order version -> dataset, as publishDatasetVersion.
            version = must(load_version(session, version_id, for_update=True), "version")
            if version["status"] == "PUBLISHED":
                return OutputDatasetState(dataset_id, version_id, "PUBLISHED")
            statuses: set[str] = set(
                session.execute(
                    select(dataset_files.c.status).where(dataset_files.c.dataset_version_id == version_id)
                ).scalars()
            )
            if "FAILED" in statuses:
                return OutputDatasetState(dataset_id, version_id, "FAILED")
            if statuses != {"VERIFIED"}:
                return OutputDatasetState(dataset_id, version_id, "DRAFT")
            ds = must(load_dataset(session, dataset_id, for_update=True), "dataset")
            if ds["status"] != "ACTIVE":
                raise CatalogPublishRejected(
                    "the dataset was withdrawn before its first version was published"
                )
            finalize_publish(
                session, ds=ds, version=version, published_by=published_by, actor=actor, deps=deps
            )
        return OutputDatasetState(dataset_id, version_id, "PUBLISHED")


def _lock_version(session: Session, version_id: UUID) -> None:
    """Global lock order version -> upload session -> file (as the verify job and completeUploadSession)."""
    session.execute(
        select(dataset_versions.c.dataset_version_id)
        .where(dataset_versions.c.dataset_version_id == version_id)
        .with_for_update(read=True)
    )


def _copy(store: ObjectStore, source_key: str, f: RowMapping) -> tuple[str, str | None]:
    key = f["storage_key"]
    try:
        if store.head(key) is None:  # a resumed call may find the copy already made
            store.copy(source_key, key)
    except ObjectMissing:
        return "FAILED", "OBJECT_MISSING"
    size = store.head(key)
    if size is None:
        return "FAILED", "OBJECT_MISSING"
    if size != int(f["size_bytes"]):
        store.delete(key)
        return "FAILED", "SIZE_MISMATCH"
    return "UPLOADED", None
