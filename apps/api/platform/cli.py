"""Platform CLI. Run: python -m api.platform.cli <command>"""

import argparse
import sys
from collections.abc import Sequence

from api.platform.broker import configure_broker
from api.platform.logs import configure_logging
from api.platform.migrate import (
    PLATFORM_TARGET,
    MigrationTarget,
    migration_targets,
    new_revision,
    upgrade_all,
)
from api.platform.modules import discover_modules
from api.platform.seed import run_seed
from api.platform.settings import get_settings
from api.platform.storage import ensure_buckets


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m api.platform.cli")
    commands = parser.add_subparsers(dest="command", required=True)
    migrate = commands.add_parser("migrate", help="upgrade platform + every module to head")
    migrate.add_argument("--sql", action="store_true", help="print SQL instead of executing (dry run)")
    revision = commands.add_parser("new-migration", help="create an empty revision for a module")
    revision.add_argument("module")
    revision.add_argument("-m", "--message", required=True)
    commands.add_parser("seed", help="load 10_SEED_DATA.md data")
    commands.add_parser("storage-init", help="create institution buckets")
    args = parser.parse_args(argv)

    settings = get_settings()
    configure_logging(settings.log_level)

    if args.command == "storage-init":
        for bucket in ensure_buckets(settings.storage_org_code_list):
            print(f"created bucket {bucket}")
        return 0

    configure_broker(settings)  # modules may define dramatiq actors at import time
    modules = discover_modules()

    if args.command == "migrate":
        for name in upgrade_all(settings.migration_database_url, modules, sql=args.sql):
            print(f"migrated {name}", file=sys.stderr if args.sql else sys.stdout)
        return 0

    if args.command == "new-migration":
        targets: dict[str, MigrationTarget] = {t.name: t for t in migration_targets(modules)}
        targets["platform"] = PLATFORM_TARGET
        target = targets.get(args.module)
        if target is None:
            print(f"unknown module {args.module!r} (needs ModuleSpec.migrations_dir)", file=sys.stderr)
            return 2
        print(new_revision(settings.migration_database_url, target, args.message))
        return 0

    for name in run_seed(modules, url=settings.database_url):
        print(f"seeded {name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
