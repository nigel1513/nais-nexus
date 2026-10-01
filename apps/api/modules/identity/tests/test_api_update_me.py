from api.modules.identity.seed_data import USERS_BY_EMAIL
from api.modules.identity.tests.support import bearer, events, make_client, scalar, token_for
from api.platform.testing.contracts import assert_matches_response, assert_valid_event
from api.platform.testing.fixtures import PgUrls

A = "a.admin@inst-a.local"


def test_set_and_clear_ntis_number(seeded: PgUrls) -> None:
    client = make_client(seeded)
    response = client.patch(
        "/api/v1/me", json={"national_researcher_number": "12345678"}, headers=bearer(token_for(A))
    )
    assert response.status_code == 200, response.text
    assert_matches_response("updateMe", 200, response.json())
    assert response.json()["national_researcher_number"] == "12345678"
    [event] = events(seeded, "identity.user.updated.v1")
    assert_valid_event(event)
    assert event["payload"]["changed_fields"] == ["national_researcher_number"]
    cleared = client.patch(
        "/api/v1/me", json={"national_researcher_number": None}, headers=bearer(token_for(A))
    )
    assert cleared.status_code == 200
    assert cleared.json()["national_researcher_number"] is None
    assert (
        scalar(
            seeded,
            "SELECT national_researcher_number FROM identity.users WHERE user_id = :u",
            u=USERS_BY_EMAIL[A].user_id,
        )
        is None
    )


def test_same_value_is_a_noop_without_event(seeded: PgUrls) -> None:
    client = make_client(seeded)
    client.patch("/api/v1/me", json={"national_researcher_number": "12345678"}, headers=bearer(token_for(A)))
    client.patch("/api/v1/me", json={"national_researcher_number": "12345678"}, headers=bearer(token_for(A)))
    assert len(events(seeded, "identity.user.updated.v1")) == 1


def test_bad_format_and_empty_body_are_422(seeded: PgUrls) -> None:
    client = make_client(seeded)
    for body in ({"national_researcher_number": "1234"}, {"national_researcher_number": "abcdefgh"}, {}):
        response = client.patch("/api/v1/me", json=body, headers=bearer(token_for(A)))
        assert response.status_code == 422, body
        assert_matches_response("updateMe", 422, response.json())


def test_duplicate_is_conflict(seeded: PgUrls) -> None:
    client = make_client(seeded)
    client.patch("/api/v1/me", json={"national_researcher_number": "12345678"}, headers=bearer(token_for(A)))
    response = client.patch(
        "/api/v1/me",
        json={"national_researcher_number": "12345678"},
        headers=bearer(token_for("b.admin@inst-b.local")),
    )
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "CONFLICT"
    assert response.json()["error"]["details"] == {"field": "national_researcher_number"}


def test_profiles_and_directory_expose_the_number(seeded: PgUrls) -> None:
    from api.modules.identity.query import SqlIdentityQuery
    from api.platform.db import session_scope

    researcher = USERS_BY_EMAIL["a.researcher@inst-a.local"]
    port = SqlIdentityQuery(lambda: session_scope(seeded.app))
    assert (
        port.get_public_profiles([researcher.user_id])[researcher.user_id].national_researcher_number
        == "10000001"
    )
    listed = (
        make_client(seeded)
        .get("/api/v1/users", params={"q": "A Researcher"}, headers=bearer(token_for(A)))
        .json()["items"]
    )
    assert listed[0]["national_researcher_number"] == "10000001"
