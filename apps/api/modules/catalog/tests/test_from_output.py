"""CatalogPublishPort (M13 output publication): dataset + v1 from stored output objects, through the normal
upload-verification-publish rules (copy server-side, verify, publish once every file is VERIFIED)."""

import hashlib
from dataclasses import replace
from typing import Any
from uuid import UUID

import pytest

from api.modules.catalog.deps import CatalogDeps
from api.modules.catalog.domain import storage_key
from api.modules.catalog.jobs import verify_file_job
from api.modules.catalog.public import (
    CatalogPublishPort,
    CatalogPublishRejected,
    OutputDatasetState,
    OutputFileSource,
)
from api.modules.catalog.settings import CatalogSettings
from api.modules.catalog.testing import MemoryObjectStore, RecordingVerificationQueue, memory_store
from api.modules.catalog.tests.support import ORG_A, ORG_B, outbox_events, rows, seed_user_id
from api.modules.catalog.tests.support_api import CatalogApi
from api.platform import ports
from api.platform.ids import new_id
from api.platform.testing.contracts import assert_valid_event
from api.platform.testing.fixtures import PgUrls

CSV = b"x,y\n1,2\n3,4\n"
PARQUET = b"PAR1" + b"\x00" * 16 + b"PAR1"
REQUESTER = seed_user_id("0b02")
APPROVER = seed_user_id("0b03")
NOTE = "프로젝트 산출물에서 공개됨. 원본: 이차전지 충방전 측정@v2"


def put(api: CatalogApi, key: str, data: bytes, org: str = "inst-b") -> MemoryObjectStore:
    store = memory_store(api.deps.storage, org)
    store.put(key, data, "text/csv")
    return store


def source(
    path: str, data: bytes, *, key: str | None = None, org: str = "inst-b", media_type: str = "text/csv"
) -> OutputFileSource:
    return OutputFileSource(
        path=path,
        size_bytes=len(data),
        sha256=hashlib.sha256(data).hexdigest(),
        media_type=media_type,
        storage_org_code=org,
        storage_key=key or f"workspace/p/outputs/o/{path}",
    )


def create(files: list[OutputFileSource], dataset_id: UUID | None = None, **extra: Any) -> OutputDatasetState:
    args: dict[str, Any] = {
        "dataset_id": dataset_id or new_id(),
        "owner_organization_id": ORG_B,
        "title": "고온 구간 평균 용량",
        "description": "",
        "access_level": "CONTROLLED",
        "allowed_purposes": ["ACADEMIC_RESEARCH"],
        "files": files,
        "lineage_note": NOTE,
        "created_by": REQUESTER,
        "published_by": APPROVER,
        "publisher_organization_id": ORG_B,
    }
    return ports.get(CatalogPublishPort).create_dataset_from_output(**(args | extra))


def test_the_port_is_registered(api: CatalogApi) -> None:
    assert ports.get(CatalogPublishPort) is not None


def test_creates_and_publishes_v1_from_the_output_objects(api: CatalogApi, db: PgUrls) -> None:
    src = source("result.csv", CSV)
    store = put(api, src.storage_key, CSV)
    dataset_id = new_id()
    state = create([src], dataset_id)
    assert state.status == "PUBLISHED" and state.dataset_id == dataset_id
    [ds] = rows(db, "SELECT * FROM catalog.datasets WHERE dataset_id = :d", d=dataset_id)
    assert (ds["owner_organization_id"], ds["title"], ds["access_level"]) == (
        ORG_B,
        "고온 구간 평균 용량",
        "CONTROLLED",
    )
    assert ds["provenance"] == NOTE and ds["created_by"] == REQUESTER and ds["approval_required"]
    [version] = rows(db, "SELECT * FROM catalog.dataset_versions WHERE dataset_id = :d", d=dataset_id)
    assert (version["dataset_version_id"], version["version_label"], version["status"]) == (
        state.dataset_version_id,
        "v1",
        "PUBLISHED",
    )
    assert version["published_by"] == APPROVER and version["file_count"] == 1
    assert version["metadata_snapshot"]["provenance"] == NOTE
    [f] = rows(
        db, "SELECT * FROM catalog.dataset_files WHERE dataset_version_id = :v", v=state.dataset_version_id
    )
    assert (f["path"], f["status"], f["storage_bucket"]) == ("result.csv", "VERIFIED", "nais-inst-b")
    assert f["storage_key"] == storage_key(
        dataset_id, state.dataset_version_id, f["upload_session_id"], "result.csv"
    )
    assert store.objects[f["storage_key"]] == CSV and store.objects[src.storage_key] == CSV  # a copy
    [sess] = rows(db, "SELECT status, created_by FROM catalog.upload_sessions")
    assert (sess["status"], sess["created_by"]) == ("COMPLETED", REQUESTER)
    [created] = outbox_events(db, "catalog.dataset.created.v1")
    [published] = outbox_events(db, "catalog.dataset.version_published.v1")
    for event in (created, published):
        assert_valid_event(event)
        assert event["actor"] == {"type": "USER", "user_id": str(APPROVER), "organization_id": str(ORG_B)}
    assert published["payload"]["dataset_id"] == str(dataset_id)


def test_calling_again_resumes_instead_of_duplicating(api: CatalogApi, db: PgUrls) -> None:
    src = source("result.csv", CSV)
    put(api, src.storage_key, CSV)
    dataset_id = new_id()
    first = create([src], dataset_id)
    again = create([src], dataset_id)
    assert again == first
    assert len(rows(db, "SELECT 1 FROM catalog.dataset_versions WHERE dataset_id = :d", d=dataset_id)) == 1
    assert len(outbox_events(db, "catalog.dataset.version_published.v1")) == 1


def test_large_files_wait_for_the_verify_worker_then_publish(api: CatalogApi, db: PgUrls) -> None:
    api.use(replace(api.deps, settings=CatalogSettings(catalog_sync_verify_max_bytes=4)))
    deps: CatalogDeps = api.deps
    src = source("result.parquet", PARQUET, media_type="application/vnd.apache.parquet")
    put(api, src.storage_key, PARQUET)
    dataset_id = new_id()
    state = create([src], dataset_id)
    assert state.status == "DRAFT"
    queue = deps.verification
    assert isinstance(queue, RecordingVerificationQueue)
    [file_id] = queue.enqueued
    assert create([src], dataset_id).status == "DRAFT"  # nothing verified yet; not re-enqueued
    assert queue.enqueued == [file_id]
    assert verify_file_job(file_id, deps=deps) == "VERIFIED"
    assert create([src], dataset_id).status == "PUBLISHED"


def test_a_missing_source_object_fails_the_file_and_the_publication(api: CatalogApi, db: PgUrls) -> None:
    state = create([source("result.csv", CSV)])
    assert state.status == "FAILED"
    [f] = rows(db, "SELECT status, failure_code FROM catalog.dataset_files")
    assert (f["status"], f["failure_code"]) == ("FAILED", "OBJECT_MISSING")
    assert rows(db, "SELECT status FROM catalog.dataset_versions")[0]["status"] == "DRAFT"


def test_a_checksum_mismatch_fails_verification(api: CatalogApi, db: PgUrls) -> None:
    src = replace(source("result.csv", CSV), sha256="0" * 64)
    put(api, src.storage_key, CSV)
    assert create([src]).status == "FAILED"
    [f] = rows(db, "SELECT status, failure_code FROM catalog.dataset_files")
    assert (f["status"], f["failure_code"]) == ("FAILED", "CHECKSUM_MISMATCH")


def test_output_file_problems_apply_the_upload_rules(api: CatalogApi) -> None:
    port = ports.get(CatalogPublishPort)
    assert port.output_file_problems([source("result.csv", CSV)]) == []
    problems = port.output_file_problems(
        [
            source("report.pdf", b"%PDF", media_type="application/pdf"),
            source("../x.csv", CSV),
            source("a.csv", CSV),
            source("a.csv", CSV),
        ]
    )
    assert {"path": "report.pdf", "reason": "FILE_TYPE_NOT_ALLOWED"} in problems
    assert {"path": "../x.csv", "reason": "DOT_SEGMENT"} in problems
    assert {"path": "a.csv", "reason": "DUPLICATE_PATH"} in problems


def test_rejects_files_that_break_the_upload_rules(api: CatalogApi, db: PgUrls) -> None:
    with pytest.raises(CatalogPublishRejected):
        create([source("report.pdf", b"%PDF", media_type="application/pdf")])
    assert rows(db, "SELECT 1 FROM catalog.datasets") == []


def test_rejects_sources_outside_the_owner_storage(api: CatalogApi, db: PgUrls) -> None:
    src = source("result.csv", CSV, org="inst-a")
    put(api, src.storage_key, CSV, org="inst-a")
    with pytest.raises(CatalogPublishRejected):
        create([src])
    with pytest.raises(CatalogPublishRejected):
        create([source("result.csv", CSV)], owner_organization_id=ORG_A, publisher_organization_id=ORG_A)
    assert rows(db, "SELECT 1 FROM catalog.datasets") == []


def test_memory_store_copy(api: CatalogApi) -> None:
    store = put(api, "a/b.csv", CSV)
    store.copy("a/b.csv", "c/d.csv")
    assert store.objects["c/d.csv"] == CSV
