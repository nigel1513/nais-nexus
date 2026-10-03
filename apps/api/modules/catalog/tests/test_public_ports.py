import io
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from typing import BinaryIO
from uuid import UUID, uuid4

import pytest

from api.modules.catalog import objects
from api.modules.catalog.ports import CatalogNotFound as AliasNotFound
from api.modules.catalog.ports import ObjectMissing as AliasObjectMissing
from api.modules.catalog.public import (
    CatalogNotFound,
    CatalogQueryPort,
    CatalogReadPort,
    DatasetPolicyView,
    ObjectMissing,
    StoragePort,
    StorageUnavailable,
)
from api.modules.catalog.testing import memory_store
from api.modules.catalog.tests.support import ORG_B, SHA_A, insert_version, rows
from api.modules.catalog.tests.support_api import USERS, CatalogApi, create_dataset, new_draft, publish_draft
from api.modules.catalog.tests.support_upload import upload_files
from api.platform import clock, ports
from api.platform.storage import StorageNotConfigured
from api.platform.testing.fixtures import PgUrls

FILES = {"data/b.csv": b"x,y\n3,4\n", "B.md": b"# B\n", "data/a.csv": b"x,y\n1,2\n"}


def published_version(api: CatalogApi, db: PgUrls) -> tuple[str, str]:
    dataset_id, version_id = new_draft(api)
    upload_files(api, db, version_id, FILES)
    assert publish_draft(api, version_id).status_code == 200
    return dataset_id, version_id


def test_ports_are_registered_by_install(api: CatalogApi) -> None:
    assert ports.get(CatalogQueryPort) is not None
    assert ports.get(StoragePort) is not None
    assert ports.get(CatalogReadPort) is not None
    assert AliasNotFound is CatalogNotFound


def test_get_policy_view(api: CatalogApi) -> None:
    created = create_dataset(api)
    view = ports.get(CatalogQueryPort).get_policy_view(UUID(created["dataset_id"]))
    assert view == DatasetPolicyView(
        dataset_id=UUID(created["dataset_id"]),
        owner_organization_id=ORG_B,
        access_level="CONTROLLED",
        allowed_purposes=("ACADEMIC_RESEARCH", "AI_TRAINING"),
        approval_required=True,
        max_grant_days=180,
        status="ACTIVE",
        title="Battery Cycling Measurements",
    )
    assert ports.get(CatalogQueryPort).get_policy_view(uuid4()) is None


def test_get_version_exposes_files_in_path_order_and_the_snapshot(api: CatalogApi, db: PgUrls) -> None:
    dataset_id, version_id = published_version(api, db)
    view = ports.get(CatalogQueryPort).get_version(UUID(version_id))
    assert view is not None
    assert (view.status, view.version_label, view.owner_organization_id) == ("PUBLISHED", "v1", ORG_B)
    assert [f.path for f in view.files] == ["B.md", "data/a.csv", "data/b.csv"]
    assert all(f.status == "VERIFIED" and f.storage_bucket == "nais-inst-b" for f in view.files)
    [stored] = rows(
        db,
        "SELECT upload_session_id FROM catalog.dataset_files WHERE dataset_version_id = :v AND path = 'data/a.csv'",
        v=version_id,
    )
    assert view.files[1].storage_key == (
        f"datasets/{dataset_id}/{version_id}/{stored['upload_session_id']}/data/a.csv"
    )
    assert (
        view.metadata_snapshot is not None
        and view.metadata_snapshot["title"] == "Battery Cycling Measurements"
    )
    assert (
        view.manifest_sha256
        == api.get("b.steward", f"/dataset-versions/{version_id}").json()["manifest_sha256"]
    )
    _, draft_id = new_draft(api)
    draft = ports.get(CatalogQueryPort).get_version(UUID(draft_id))
    assert draft is not None and draft.metadata_snapshot is None and draft.files == ()
    assert ports.get(CatalogQueryPort).get_version(uuid4()) is None


def test_is_visible_matches_d012(api: CatalogApi, db: PgUrls) -> None:
    internal = UUID(create_dataset(api, access_level="INTERNAL")["dataset_id"])
    insert_version(db, internal, published=True, files=[("a.csv", 1, SHA_A)])
    port = ports.get(CatalogQueryPort)
    assert port.is_visible(USERS["b.researcher"], internal) is True
    assert port.is_visible(USERS["a.researcher"], internal) is False
    assert port.is_visible(USERS["a.researcher"], uuid4()) is False


def test_get_latest_published_version(api: CatalogApi, db: PgUrls) -> None:
    dataset_id = UUID(create_dataset(api)["dataset_id"])
    port = ports.get(CatalogQueryPort)
    assert port.get_latest_published_version(dataset_id) is None
    insert_version(db, dataset_id, label="draft")
    assert port.get_latest_published_version(dataset_id) is None
    v1 = insert_version(
        db, dataset_id, label="v1", published=True, published_at=datetime(2026, 9, 1, tzinfo=UTC)
    )
    v2 = insert_version(
        db, dataset_id, label="v2", published=True, published_at=datetime(2026, 9, 2, tzinfo=UTC)
    )
    latest = port.get_latest_published_version(dataset_id)
    assert latest is not None
    assert (latest.dataset_version_id, latest.version_label, latest.status) == (v2, "v2", "PUBLISHED")
    assert latest == port.get_version(v2) and v1 != v2
    assert port.get_latest_published_version(uuid4()) is None


def test_presign_get_signs_verified_files_as_attachments(api: CatalogApi, db: PgUrls) -> None:
    _, version_id = published_version(api, db)
    now = datetime(2026, 10, 1, 12, 0, tzinfo=UTC)
    with clock.frozen(now):
        signed = ports.get(StoragePort).presign_get(UUID(version_id), None, 300)
    assert [s.path for s in signed] == ["B.md", "data/a.csv", "data/b.csv"]
    assert all(s.expires_at == now + timedelta(seconds=300) for s in signed)
    assert signed[1].url.startswith("http://localhost:21051/nais-inst-b/datasets/")
    store = memory_store(api.deps.storage, "inst-b")
    assert [(filename, ttl) for _, filename, ttl in store.presigned_gets] == [
        ("B.md", 300),
        ("a.csv", 300),
        ("b.csv", 300),
    ]
    subset = ports.get(StoragePort).presign_get(UUID(version_id), [signed[2].file_id], 60)
    assert [s.path for s in subset] == ["data/b.csv"]


def test_at23_foreign_or_unverified_file_ids_are_not_found(api: CatalogApi, db: PgUrls) -> None:
    _, version_id = published_version(api, db)
    _, other_version = published_version(api, db)
    foreign = ports.get(CatalogQueryPort).get_version(UUID(other_version)).files[0].file_id  # type: ignore[union-attr]
    store = memory_store(api.deps.storage, "inst-b")
    store.presigned_gets.clear()
    with pytest.raises(CatalogNotFound) as caught:
        ports.get(StoragePort).presign_get(UUID(version_id), [foreign], 300)
    assert isinstance(caught.value, ValueError) and str(caught.value).startswith("NOT_FOUND")
    assert store.presigned_gets == []
    _, draft_id = new_draft(api)
    session = api.post(
        "b.steward",
        f"/dataset-versions/{draft_id}/upload-session",
        json={"files": [{"path": "p.csv", "size_bytes": 3, "sha256": SHA_A, "media_type": "text/csv"}]},
    ).json()
    with pytest.raises(CatalogNotFound):
        ports.get(StoragePort).presign_get(UUID(draft_id), [UUID(session["files"][0]["file_id"])], 300)
    with pytest.raises(CatalogNotFound):
        ports.get(StoragePort).presign_get(uuid4(), None, 300)


def test_open_stream_reads_bytes_with_the_service_credentials(api: CatalogApi, db: PgUrls) -> None:
    _, version_id = published_version(api, db)
    view = ports.get(CatalogQueryPort).get_version(UUID(version_id))
    assert view is not None
    ref = next(f for f in view.files if f.path == "data/a.csv")
    reader = ports.get(CatalogReadPort)
    assert reader.open_stream(ref).read() == FILES["data/a.csv"]
    assert reader.open_stream(ref, (2, 4)).read() == FILES["data/a.csv"][2:5]
    assert rows(db, "SELECT count(*) AS n FROM catalog.dataset_files")[0]["n"] == 3


def test_open_stream_raises_the_public_object_missing(api: CatalogApi, db: PgUrls) -> None:
    """M05 maps this to FILE_NOT_FOUND; it must not need catalog internals (W1-D1)."""
    _, version_id = published_version(api, db)
    view = ports.get(CatalogQueryPort).get_version(UUID(version_id))
    assert view is not None
    gone = replace(view.files[0], storage_key=view.files[0].storage_key + ".gone")
    with pytest.raises(ObjectMissing) as caught:
        ports.get(CatalogReadPort).open_stream(gone)
    assert AliasObjectMissing is ObjectMissing
    assert caught.value.args == (gone.path,)  # the path, never the storage key
    assert isinstance(caught.value, LookupError) and not isinstance(caught.value, objects.ObjectMissing)


def test_open_stream_raises_the_public_storage_unavailable(api: CatalogApi, db: PgUrls) -> None:
    """M05 retries the run on this (M05 §5)."""
    _, version_id = published_version(api, db)
    view = ports.get(CatalogQueryPort).get_version(UUID(version_id))
    assert view is not None
    store = memory_store(api.deps.storage, "inst-b")

    def down(key: str, byte_range: tuple[int, int] | None = None) -> BinaryIO:
        raise objects.StorageUnavailable("storage-b down")

    store.open_stream = down  # type: ignore[method-assign]
    with pytest.raises(StorageUnavailable) as caught:
        ports.get(CatalogReadPort).open_stream(view.files[0])
    assert isinstance(caught.value, RuntimeError) and not isinstance(caught.value, objects.StorageUnavailable)


def test_mid_read_storage_errors_surface_as_public_storage_unavailable(api: CatalogApi, db: PgUrls) -> None:
    """The body can fail after open_stream returned (connection reset while streaming)."""
    _, version_id = published_version(api, db)
    view = ports.get(CatalogQueryPort).get_version(UUID(version_id))
    assert view is not None
    store = memory_store(api.deps.storage, "inst-b")

    class Breaking(io.BytesIO):
        def read(self, size: int | None = -1) -> bytes:
            raise objects.StorageUnavailable("connection reset mid-read")

    store.open_stream = lambda key, byte_range=None: Breaking(b"x")  # type: ignore[method-assign, assignment]
    stream = ports.get(CatalogReadPort).open_stream(view.files[0])
    with pytest.raises(StorageUnavailable):
        stream.read()
    with pytest.raises(StorageUnavailable):
        stream.readinto(bytearray(4))  # type: ignore[attr-defined]
    stream.close()


def test_open_stream_rejects_forged_file_refs(api: CatalogApi, db: PgUrls) -> None:
    _, version_id = published_version(api, db)
    view = ports.get(CatalogQueryPort).get_version(UUID(version_id))
    assert view is not None
    real = view.files[0]
    reader = ports.get(CatalogReadPort)
    for forged in (
        replace(real, storage_key="datasets/other/key.csv"),
        replace(real, storage_bucket="nais-inst-a"),
        replace(real, file_id=uuid4()),
    ):
        with pytest.raises(ObjectMissing):
            reader.open_stream(forged)
    # a file of a DRAFT version, with its true bucket and key
    _, draft_id = new_draft(api)
    session = api.post(
        "b.steward",
        f"/dataset-versions/{draft_id}/upload-session",
        json={"files": [{"path": "p.csv", "size_bytes": 3, "sha256": SHA_A, "media_type": "text/csv"}]},
    ).json()
    draft_file = ports.get(CatalogQueryPort).get_version(UUID(draft_id)).files[0]  # type: ignore[union-attr]
    assert str(draft_file.file_id) == session["files"][0]["file_id"]
    with pytest.raises(ObjectMissing):
        reader.open_stream(draft_file)


def test_open_stream_rejects_a_bad_byte_range(api: CatalogApi, db: PgUrls) -> None:
    _, version_id = published_version(api, db)
    ref = ports.get(CatalogQueryPort).get_version(UUID(version_id)).files[0]  # type: ignore[union-attr]
    for bad in ((-1, 3), (5, 2)):
        with pytest.raises(ValueError):
            ports.get(CatalogReadPort).open_stream(ref, bad)


def test_presign_skips_non_verified_files_of_a_published_version(api: CatalogApi, db: PgUrls) -> None:
    dataset_id = UUID(create_dataset(api)["dataset_id"])
    version_id = insert_version(
        db, dataset_id, published=True, files=[("bad.csv", 1, SHA_A)], file_status="FAILED"
    )
    view = ports.get(CatalogQueryPort).get_version(version_id)
    assert view is not None and [f.status for f in view.files] == ["FAILED"]
    assert ports.get(StoragePort).presign_get(version_id, None, 60) == []
    with pytest.raises(CatalogNotFound):
        ports.get(StoragePort).presign_get(version_id, [view.files[0].file_id], 60)
    with pytest.raises(ObjectMissing):
        ports.get(CatalogReadPort).open_stream(view.files[0])


def test_unconfigured_bucket_is_a_public_storage_unavailable(
    api: CatalogApi, db: PgUrls, monkeypatch: pytest.MonkeyPatch
) -> None:
    _, version_id = published_version(api, db)
    view = ports.get(CatalogQueryPort).get_version(UUID(version_id))
    assert view is not None
    with pytest.raises(ObjectMissing):  # a bucket that is not the stored one is a forged FileRef
        ports.get(CatalogReadPort).open_stream(replace(view.files[0], storage_bucket="no-such-bucket"))

    def unconfigured(bucket: str) -> object:
        raise StorageNotConfigured(f"no storage configuration for bucket {bucket!r}")

    monkeypatch.setattr(api.deps.storage, "for_bucket", unconfigured)
    with pytest.raises(StorageUnavailable):
        ports.get(StoragePort).presign_get(UUID(version_id), None, 60)
    with pytest.raises(StorageUnavailable):
        ports.get(CatalogReadPort).open_stream(view.files[0])


def test_presign_rejects_a_non_positive_ttl(api: CatalogApi, db: PgUrls) -> None:
    _, version_id = published_version(api, db)
    with pytest.raises(ValueError):
        ports.get(StoragePort).presign_get(UUID(version_id), None, 0)


def test_list_visible_dataset_summaries_uses_d012_in_one_batch(api: CatalogApi, db: PgUrls) -> None:
    from api.modules.catalog.public import DatasetSummary

    shared = UUID(create_dataset(api, title="Shared", subject_codes=["MATERIALS", "ENERGY"])["dataset_id"])
    insert_version(db, shared, label="v1", published=True, published_at=datetime(2026, 9, 1, tzinfo=UTC))
    insert_version(db, shared, label="v2", published=True, published_at=datetime(2026, 9, 3, tzinfo=UTC))
    internal = UUID(create_dataset(api, title="Internal", access_level="INTERNAL")["dataset_id"])
    insert_version(db, internal, published=True)
    unpublished = UUID(create_dataset(api, title="Draft only")["dataset_id"])
    port = ports.get(CatalogQueryPort)

    outsider = {s.dataset_id: s for s in port.list_visible_dataset_summaries(USERS["a.researcher"])}
    assert set(outsider) == {shared}
    summary = outsider[shared]
    assert isinstance(summary, DatasetSummary)
    assert (summary.title, summary.owner_organization_id, summary.owner_organization_name) == (
        "Shared",
        ORG_B,
        "Institute B",
    )
    assert summary.subject_labels == ("재료", "에너지")
    assert (summary.access_level, summary.status, summary.readiness_overall) == ("CONTROLLED", "ACTIVE", None)
    assert summary.latest_published_at == datetime(2026, 9, 3, tzinfo=UTC)
    assert summary.updated_at is not None

    owner = {s.dataset_id: s for s in port.list_visible_dataset_summaries(USERS["b.researcher"])}
    assert set(owner) == {shared, internal, unpublished}
    assert owner[unpublished].latest_published_at is None
