"""M09 Audit & Notification (NAIS_PRD/modules/M09_audit_notification.md)."""

from pathlib import Path

from api.modules.audit import handlers  # noqa: F401  (registers event subscriptions at import)
from api.modules.audit.api import router
from api.modules.audit.jobs import register_worker
from api.platform.modules import ModuleSpec

MODULE = ModuleSpec(
    name="audit",
    db_schema="audit",
    router=router,
    migrations_dir=Path(__file__).parent / "migrations",
    register_worker=register_worker,
)
