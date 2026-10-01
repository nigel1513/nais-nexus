"""Catalog test fixtures.

A Dramatiq StubBroker is installed as the global broker so nothing in the catalog tests reaches Redis
(DramatiqVerificationQueue sends through dramatiq.get_broker()). Fixture modules are imported below and
registered by name.
"""

from dramatiq.brokers.stub import StubBroker

from api.platform.broker import configure_broker
from api.platform.settings import Settings

configure_broker(Settings(), StubBroker())

from api.modules.catalog.tests.fixtures_db import catalog_db, db  # noqa: E402, F401
