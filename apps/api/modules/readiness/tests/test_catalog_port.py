import api.modules.catalog.public as catalog_public
from api.modules.readiness import catalog_port


def test_catalog_port_reexports_the_m03_public_classes() -> None:
    """W1-D1: the registry key is the provider's public.py class, never a readiness-side copy."""
    assert catalog_port.CatalogQueryPort is catalog_public.CatalogQueryPort
    assert catalog_port.CatalogReadPort is catalog_public.CatalogReadPort
    assert catalog_port.FileRef is catalog_public.FileRef
    assert catalog_port.VersionView is catalog_public.VersionView
    assert catalog_port.ObjectMissing is catalog_public.ObjectMissing
    assert catalog_port.StorageUnavailable is catalog_public.StorageUnavailable
