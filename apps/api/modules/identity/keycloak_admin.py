"""Keycloak admin REST seam for transferUserOrganization (org_code user attribute, D-019 token claim)."""

from typing import Any, Protocol

import httpx


class KeycloakAdminUnavailable(RuntimeError):  # noqa: N818
    pass


class KeycloakAdminPort(Protocol):
    def set_org_code(self, keycloak_sub: str, org_code: str) -> None: ...


class HttpKeycloakAdmin:
    """Master-realm admin-cli password grant (dev credentials, D-037), then GET + PUT the user representation."""

    def __init__(
        self,
        base_url: str,
        realm: str,
        admin_user: str,
        admin_password: str,
        *,
        timeout: float = 5.0,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self._base = base_url.rstrip("/")
        self._realm = realm
        self._credentials = {
            "grant_type": "password",
            "client_id": "admin-cli",
            "username": admin_user,
            "password": admin_password,
        }
        self._timeout = timeout
        self._transport = transport

    def set_org_code(self, keycloak_sub: str, org_code: str) -> None:
        try:
            with httpx.Client(timeout=self._timeout, transport=self._transport) as client:
                token = self._ok(
                    client.post(
                        f"{self._base}/realms/master/protocol/openid-connect/token", data=self._credentials
                    )
                ).json()["access_token"]
                headers = {"Authorization": f"Bearer {token}"}
                url = f"{self._base}/admin/realms/{self._realm}/users/{keycloak_sub}"
                user: dict[str, Any] = self._ok(client.get(url, headers=headers)).json()
                attributes = dict(user.get("attributes") or {})
                attributes["org_code"] = [org_code]
                user["attributes"] = attributes
                self._ok(client.put(url, headers=headers, json=user))
        except (httpx.HTTPError, KeyError, ValueError) as exc:
            raise KeycloakAdminUnavailable(str(exc)) from exc

    @staticmethod
    def _ok(response: httpx.Response) -> httpx.Response:
        if response.status_code >= 300:
            raise KeycloakAdminUnavailable(
                f"keycloak admin {response.request.method} -> {response.status_code}"
            )
        return response


class FakeKeycloakAdmin:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str]] = []
        self.fail = False

    def set_org_code(self, keycloak_sub: str, org_code: str) -> None:
        if self.fail:
            raise KeycloakAdminUnavailable("fake failure")
        self.calls.append((keycloak_sub, org_code))
