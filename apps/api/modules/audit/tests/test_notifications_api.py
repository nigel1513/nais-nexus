import uuid
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID

from sqlalchemy import text

from api.modules.audit.fakes import A_RESEARCHER, B_RESEARCHER
from api.modules.audit.tests.support.auth import auth, make_client
from api.modules.audit.tests.support.db import scalar
from api.platform.db import session_factory
from api.platform.testing.contracts import assert_matches_response
from api.platform.testing.fixtures import PgUrls

T0 = datetime(2026, 10, 1, tzinfo=UTC)


def add(db: PgUrls, recipient: UUID, title: str, *, minutes: int, read: bool = False) -> UUID:
    nid = uuid.uuid4()
    created = T0 + timedelta(minutes=minutes)
    with session_factory(db.app)() as s, s.begin():
        s.execute(
            text(
                "INSERT INTO audit.notifications (notification_id, recipient_user_id, type, title, body, link, "
                "source_event_id, read_at, created_at) VALUES (:n, :r, 'ACCESS_APPROVED', :t, '', '/commons/access/x', "
                ":s, :read_at, :c)"
            ),
            {
                "n": nid,
                "r": recipient,
                "t": title,
                "s": uuid.uuid4(),
                "read_at": created if read else None,
                "c": created,
            },
        )
    return nid


def listing(db: PgUrls, user: UUID, **params: Any) -> Any:
    response = make_client(db).get("/api/v1/notifications", params=params, headers=auth(user))
    assert response.status_code == 200
    assert_matches_response("listNotifications", 200, response.json())
    return response.json()


def test_unauthenticated_is_401(db: PgUrls) -> None:
    listed = make_client(db).get("/api/v1/notifications")
    assert listed.status_code == 401
    assert_matches_response("listNotifications", 401, listed.json())  # 401 declared by M00 (openapi 1.2.0)
    read_all = make_client(db).post("/api/v1/notifications/read-all")
    assert read_all.status_code == 401
    assert_matches_response("markAllNotificationsRead", 401, read_all.json())


def test_lists_only_my_notifications_newest_first_with_unread_count(db: PgUrls) -> None:
    add(db, A_RESEARCHER, "first", minutes=1)
    add(db, A_RESEARCHER, "second", minutes=2, read=True)
    add(db, B_RESEARCHER, "not mine", minutes=3)
    body = listing(db, A_RESEARCHER)
    assert [i["title"] for i in body["items"]] == ["second", "first"]
    assert [i["read"] for i in body["items"]] == [True, False]
    assert body["unread_count"] == 1


def test_unread_only_and_pagination(db: PgUrls) -> None:
    for m in range(5):
        add(db, A_RESEARCHER, f"n{m}", minutes=m)
    add(db, A_RESEARCHER, "read", minutes=10, read=True)
    assert [i["title"] for i in listing(db, A_RESEARCHER, unread_only=True)["items"]] == [
        "n4",
        "n3",
        "n2",
        "n1",
        "n0",
    ]
    first = listing(db, A_RESEARCHER, limit=4)
    assert first["page"]["has_more"] is True and len(first["items"]) == 4
    second = listing(db, A_RESEARCHER, limit=4, cursor=first["page"]["next_cursor"])
    assert [i["title"] for i in second["items"]] == ["n1", "n0"]
    assert second["page"]["has_more"] is False


def test_mark_read_is_idempotent(db: PgUrls) -> None:
    nid = add(db, A_RESEARCHER, "x", minutes=1)
    client = make_client(db)
    first = client.post(f"/api/v1/notifications/{nid}/read", headers=auth(A_RESEARCHER))
    assert first.status_code == 200
    assert_matches_response("markNotificationRead", 200, first.json())
    assert first.json()["read"] is True
    read_at = scalar(db, "SELECT read_at FROM audit.notifications WHERE notification_id = :n", n=nid)
    again = client.post(f"/api/v1/notifications/{nid}/read", headers=auth(A_RESEARCHER))
    assert again.status_code == 200 and again.json()["read"] is True
    assert scalar(db, "SELECT read_at FROM audit.notifications WHERE notification_id = :n", n=nid) == read_at


def test_marking_someone_elses_notification_is_404(db: PgUrls) -> None:  # M09-AT-13
    nid = add(db, A_RESEARCHER, "x", minutes=1)
    response = make_client(db).post(f"/api/v1/notifications/{nid}/read", headers=auth(B_RESEARCHER))
    assert response.status_code == 404
    assert_matches_response("markNotificationRead", 404, response.json())
    assert response.json()["error"]["code"] == "NOTIFICATION_NOT_FOUND"
    assert scalar(db, "SELECT read_at FROM audit.notifications WHERE notification_id = :n", n=nid) is None


def test_unknown_notification_is_404(db: PgUrls) -> None:
    response = make_client(db).post(f"/api/v1/notifications/{uuid.uuid4()}/read", headers=auth(A_RESEARCHER))
    assert response.status_code == 404 and response.json()["error"]["code"] == "NOTIFICATION_NOT_FOUND"


def test_read_all_marks_only_mine(db: PgUrls) -> None:
    add(db, A_RESEARCHER, "a1", minutes=1)
    add(db, A_RESEARCHER, "a2", minutes=2)
    add(db, B_RESEARCHER, "b1", minutes=3)
    response = make_client(db).post("/api/v1/notifications/read-all", headers=auth(A_RESEARCHER))
    assert response.status_code == 204
    assert_matches_response("markAllNotificationsRead", 204, response.content)
    assert listing(db, A_RESEARCHER)["unread_count"] == 0
    assert listing(db, B_RESEARCHER)["unread_count"] == 1
