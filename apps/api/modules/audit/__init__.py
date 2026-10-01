"""M09 Audit & Notification (NAIS_PRD/modules/M09_audit_notification.md)."""

from pathlib import Path

from api.platform.modules import ModuleSpec

MODULE = ModuleSpec(
    name="audit",
    db_schema="audit",
    migrations_dir=Path(__file__).parent / "migrations",
)
