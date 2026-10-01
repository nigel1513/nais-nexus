"""catalog.dataset.version_published.v1 -> auto-queue GENERIC_BASIC (+ TABULAR_ML_BASIC when T is not empty)."""

import logging
from uuid import UUID

from sqlalchemy.orm import Session

from api.modules.readiness.catalog_port import CatalogQueryPort
from api.modules.readiness.service import auto_profiles, request_validation
from api.platform import ports
from api.platform.event_bus import claim_event, subscribe
from api.platform.events import EventEnvelope
from api.platform.generated.event_types import EventType

logger = logging.getLogger("nais.readiness")
HANDLER = "on_version_published"


@subscribe(EventType.CATALOG_DATASET_VERSION_PUBLISHED_V1)
def on_version_published(session: Session, event: EventEnvelope) -> None:
    if not claim_event(session, "readiness", event, handler=HANDLER):
        return
    version = ports.get(CatalogQueryPort).get_version(UUID(event.payload["dataset_version_id"]))
    if version is None or version.status != "PUBLISHED":
        logger.warning(
            "published version not found or not PUBLISHED (status=%s); nothing queued",
            None if version is None else version.status,
            extra={"event_id": str(event.event_id)},
        )
        return
    for profile in auto_profiles(version):
        request_validation(
            session,
            version,
            profile,
            triggered_by="AUTO_ON_PUBLISH",
            requester=None,
            correlation_id=event.correlation_id,
        )
