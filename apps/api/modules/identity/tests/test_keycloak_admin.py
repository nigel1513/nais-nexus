import httpx
import pytest

from api.modules.identity.keycloak_admin import HttpKeycloakAdmin, KeycloakAdminUnavailable

USER = "kc-sub-1234"  # differs from any NAIS user_id


def test_sets_org_code_keeping_other_attributes() -> None:
    seen: list[tuple[str, str]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append((request.method, request.url.path))
        if request.url.path.endswith("/realms/master/protocol/openid-connect/token"):
            return httpx.Response(200, json={"access_token": "t"})
        if request.method == "GET":
            return httpx.Response(
                200,
                json={"id": str(USER), "username": "a", "attributes": {"org_code": ["inst-a"], "x": ["1"]}},
            )
        assert request.headers["Authorization"] == "Bearer t"
        body = httpx.Response(200, content=request.content).json()
        assert body["attributes"] == {"org_code": ["inst-b"], "x": ["1"]}
        return httpx.Response(204)

    admin = HttpKeycloakAdmin(
        "http://kc/auth", "nais", "nais", "nais", transport=httpx.MockTransport(handler)
    )
    admin.set_org_code(USER, "inst-b")
    assert [m for m, _ in seen] == ["POST", "GET", "PUT"]
    assert seen[1][1] == f"/auth/admin/realms/nais/users/{USER}"


@pytest.mark.parametrize("status", [500, 401])
def test_failures_raise_unavailable(status: int) -> None:
    admin = HttpKeycloakAdmin(
        "http://kc/auth",
        "nais",
        "nais",
        "nais",
        transport=httpx.MockTransport(lambda r: httpx.Response(status)),
    )
    with pytest.raises(KeycloakAdminUnavailable):
        admin.set_org_code(USER, "inst-b")


def test_network_error_raises_unavailable() -> None:
    def boom(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("down", request=request)

    admin = HttpKeycloakAdmin("http://kc/auth", "nais", "nais", "nais", transport=httpx.MockTransport(boom))
    with pytest.raises(KeycloakAdminUnavailable):
        admin.set_org_code(USER, "x")


def _stage_handler(fail_at: str, status: int):  # type: ignore[no-untyped-def]
    def handler(request: httpx.Request) -> httpx.Response:
        stage = "token" if request.url.path.endswith("/token") else request.method
        if stage == fail_at:
            return httpx.Response(status)
        if stage == "token":
            return httpx.Response(200, json={"access_token": "t"})
        if stage == "GET":
            return httpx.Response(200, json={"id": USER, "attributes": {}})
        return httpx.Response(204)

    return handler


@pytest.mark.parametrize(("stage", "status"), [("token", 401), ("token", 503), ("GET", 404), ("PUT", 500)])
def test_each_stage_failure_raises_unavailable(stage: str, status: int) -> None:
    admin = HttpKeycloakAdmin(
        "http://kc/auth", "nais", "nais", "nais", transport=httpx.MockTransport(_stage_handler(stage, status))
    )
    with pytest.raises(KeycloakAdminUnavailable):
        admin.set_org_code(USER, "inst-b")
