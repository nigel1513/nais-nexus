import pytest

from api.platform.storage import StorageNotConfigured, env_prefix, load_storage_config, public_client

ENV = {
    "STORAGE_INST_B_ENDPOINT": "http://storage-b:8333",
    "STORAGE_INST_B_BUCKET": "nais-inst-b",
    "STORAGE_INST_B_ACCESS_KEY": "nais-inst-b",
    "STORAGE_INST_B_SECRET_KEY": "change-me-b",
}


def test_env_prefix_is_derived_from_org_code() -> None:
    assert env_prefix("inst-b") == "STORAGE_INST_B"
    assert env_prefix("nais") == "STORAGE_NAIS"


@pytest.mark.parametrize("bad", ["INST-B", "a", "inst b", "../etc"])
def test_invalid_org_codes_are_rejected(bad: str) -> None:
    with pytest.raises(ValueError):
        env_prefix(bad)


def test_load_storage_config() -> None:
    cfg = load_storage_config("inst-b", ENV)
    assert (cfg.endpoint, cfg.bucket, cfg.access_key) == ("http://storage-b:8333", "nais-inst-b", "nais-inst-b")


def test_missing_configuration_names_the_variable() -> None:
    with pytest.raises(StorageNotConfigured, match="STORAGE_INST_A_BUCKET"):
        load_storage_config("inst-a", {"STORAGE_INST_A_ENDPOINT": "http://storage-a:8333"})


def test_public_client_presigns_path_style_urls_on_the_gateway() -> None:
    client = public_client(load_storage_config("inst-b", ENV), "http://localhost:21051")
    url = client.generate_presigned_url(
        "get_object", Params={"Bucket": "nais-inst-b", "Key": "datasets/d/v/data.csv"}, ExpiresIn=300
    )
    assert url.startswith("http://localhost:21051/nais-inst-b/datasets/d/v/data.csv?")
    assert "X-Amz-Signature=" in url
