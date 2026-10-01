"""getDataset / is_visible access matrix (D-012, M03-R3, D-040): who sees which dataset in which state."""

from uuid import UUID, uuid4

import pytest

from api.modules.catalog.public import CatalogQueryPort
from api.modules.catalog.tests.support import ORG_B, SHA_A, insert_dataset, insert_version
from api.modules.catalog.tests.support_api import USERS, CatalogApi, assert_error
from api.platform import ports
from api.platform.testing.contracts import assert_matches_response
from api.platform.testing.fixtures import PgUrls

OWNER_ORG_USERS = ("b.steward", "b.researcher", "b.admin")
OTHER_USERS = ("a.researcher", "a.steward")
ALL_USERS = (*OWNER_ORG_USERS, *OTHER_USERS, "platform.admin")
LEVELS = ("PUBLIC", "INTERNAL", "CONTROLLED", "SENSITIVE")
STATES = ("no_version", "draft_only", "published", "withdrawn")


def make_dataset(db: PgUrls, level: str, state: str) -> UUID:
    dataset_id = insert_dataset(
        db,
        owner=ORG_B,
        access_level=level,
        status="WITHDRAWN" if state == "withdrawn" else "ACTIVE",
        max_grant_days=30,
    )
    if state == "draft_only":
        insert_version(db, dataset_id, published=False, files=[("data/a.csv", 10, SHA_A)])
    elif state in ("published", "withdrawn"):
        insert_version(db, dataset_id, published=True, files=[("data/a.csv", 10, SHA_A)])
    return dataset_id


def expected_visible(user: str, level: str, state: str) -> bool:
    if user in OWNER_ORG_USERS or user == "platform.admin":
        return (
            True  # owner organization and platform admin: always, even WITHDRAWN / unpublished (reactivation)
        )
    return state == "published" and level != "INTERNAL"  # others: ACTIVE + published + not INTERNAL


@pytest.mark.parametrize("state", STATES)
@pytest.mark.parametrize("level", LEVELS)
@pytest.mark.parametrize("user", ALL_USERS)
def test_get_dataset_access_matrix(api: CatalogApi, db: PgUrls, user: str, level: str, state: str) -> None:
    dataset_id = make_dataset(db, level, state)
    response = api.get(user, f"/datasets/{dataset_id}")
    if expected_visible(user, level, state):
        assert response.status_code == 200, response.text
        assert_matches_response("getDataset", 200, response.json())
    else:
        assert_error("getDataset", response, 404, "NOT_FOUND")


@pytest.mark.parametrize("state", STATES)
@pytest.mark.parametrize("level", LEVELS)
@pytest.mark.parametrize("user", ALL_USERS)
def test_is_visible_matches_the_matrix(
    api: CatalogApi, db: PgUrls, user: str, level: str, state: str
) -> None:
    dataset_id = make_dataset(db, level, state)
    assert ports.get(CatalogQueryPort).is_visible(USERS[user], dataset_id) is expected_visible(
        user, level, state
    )


def test_get_dataset_requires_a_token(api: CatalogApi, db: PgUrls) -> None:
    dataset_id = make_dataset(db, "PUBLIC", "published")
    assert_error("getDataset", api.get(None, f"/datasets/{dataset_id}"), 401, "UNAUTHENTICATED")


def test_malformed_dataset_id_is_422(api: CatalogApi) -> None:
    response = api.get("b.steward", "/datasets/not-a-uuid")
    assert response.status_code == 422  # contract declares no 422 for getDataset; framework validation
    assert api.get("b.steward", f"/datasets/{uuid4()}").status_code == 404
