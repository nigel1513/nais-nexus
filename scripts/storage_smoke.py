"""Gate A storage smoke: presigned PUT/GET for each institute bucket through the :21051 gateway."""

import os

import httpx
from api.platform.storage import load_storage_config, public_client

BASE = os.environ.get("NAIS_PUBLIC_BASE_URL", "http://localhost:21051")


def expect(condition: bool, message: str) -> None:
    if not condition:
        raise SystemExit(f"STORAGE SMOKE FAIL: {message}")


def check(org_code: str) -> None:
    cfg = load_storage_config(org_code)
    client = public_client(cfg, BASE)
    key = f"_smoke/{org_code}.txt"
    body = f"nais gate-a {org_code}".encode()
    put_url = client.generate_presigned_url(
        "put_object", Params={"Bucket": cfg.bucket, "Key": key}, ExpiresIn=60
    )
    put = httpx.put(put_url, content=body, timeout=10)
    expect(put.status_code == 200, f"{org_code} presigned PUT returned {put.status_code}: {put.text[:200]}")
    get_url = client.generate_presigned_url(
        "get_object", Params={"Bucket": cfg.bucket, "Key": key}, ExpiresIn=60
    )
    got = httpx.get(get_url, timeout=10)
    expect(
        got.status_code == 200 and got.content == body, f"{org_code} presigned GET returned {got.status_code}"
    )
    tampered = httpx.get(get_url.replace(f"{org_code}.txt", f"{org_code}-x.txt"), timeout=10)
    expect(
        tampered.status_code == 403, f"{org_code} tampered URL returned {tampered.status_code}, expected 403"
    )
    anonymous = httpx.get(f"{BASE}/{cfg.bucket}/{key}", timeout=10)
    expect(
        anonymous.status_code == 403,
        f"{org_code} anonymous GET returned {anonymous.status_code}, expected 403",
    )
    print(f"ok  storage {org_code} ({cfg.bucket})")


if __name__ == "__main__":
    for code in ("inst-a", "inst-b"):
        check(code)
