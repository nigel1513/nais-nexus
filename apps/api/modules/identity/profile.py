"""updateMe (Wave 1.5 spec §3.0): self-service NTIS researcher number."""

from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from api.modules.identity.directory import get_me
from api.modules.identity.schemas import MeOut, MeUpdateIn
from api.modules.identity.tables import users
from api.platform import clock
from api.platform.auth import CurrentUser
from api.platform.errors import ApiError
from api.platform.events import EventActor
from api.platform.generated.error_codes import ErrorCode
from api.platform.generated.event_types import EventType
from api.platform.outbox import outbox


def update_me(session: Session, user: CurrentUser, change: MeUpdateIn) -> MeOut:
    current: str | None = session.execute(
        select(users.c.national_researcher_number).where(users.c.user_id == user.user_id).with_for_update()
    ).scalar_one()
    changed: list[str] = []
    if (
        "national_researcher_number" in change.model_fields_set
        and change.national_researcher_number != current
    ):
        changed.append("national_researcher_number")
        try:
            with session.begin_nested():
                session.execute(
                    update(users)
                    .where(users.c.user_id == user.user_id)
                    .values(
                        national_researcher_number=change.national_researcher_number, updated_at=clock.now()
                    )
                )
        except IntegrityError as exc:
            raise ApiError(
                ErrorCode.CONFLICT,
                "This NTIS researcher number is already registered by another user.",
                {"field": "national_researcher_number"},
            ) from exc
    if changed:
        outbox.write(
            session,
            EventType.IDENTITY_USER_UPDATED_V1,
            {
                "user_id": str(user.user_id),
                "organization_id": str(user.organization_id),
                "changed_fields": sorted(changed),
            },
            EventActor.for_user(user),
        )
    return get_me(session, user.user_id)
