"""Platform half of authentication (M01 §3): verify the Keycloak JWT, then ask M01's PrincipalResolver."""

from functools import lru_cache
from typing import Annotated, Any, Protocol
from uuid import UUID

import jwt
from fastapi import Depends
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, ConfigDict

from api.platform import ports
from api.platform.context import correlation_id
from api.platform.errors import ApiError
from api.platform.generated.error_codes import ErrorCode
from api.platform.settings import get_settings


class CurrentUser(BaseModel):
    model_config = ConfigDict(frozen=True)

    user_id: UUID
    organization_id: UUID
    org_roles: frozenset[str] = frozenset()
    platform_roles: frozenset[str] = frozenset()
    session_id: str
    display_name: str

    def has_org_role(self, organization_id: UUID, role: str) -> bool:
        return organization_id == self.organization_id and role in self.org_roles

    @property
    def is_platform_admin(self) -> bool:
        return "PLATFORM_ADMIN" in self.platform_roles


class PrincipalResolver(Protocol):
    def resolve(self, claims: dict[str, Any], correlation_id: UUID) -> CurrentUser: ...


class JwkClient(Protocol):
    def get_signing_key_from_jwt(self, token: str) -> Any: ...


class TokenVerifier:
    def __init__(self, *, issuer: str, audience: str, jwk_client: JwkClient, leeway: int = 30) -> None:
        self._issuer = issuer
        self._audience = audience
        self._jwk_client = jwk_client
        self._leeway = leeway

    def verify(self, token: str) -> dict[str, Any]:
        try:
            key = self._jwk_client.get_signing_key_from_jwt(token).key
            claims: dict[str, Any] = jwt.decode(
                token,
                key,
                algorithms=["RS256"],
                audience=self._audience,
                issuer=self._issuer,
                leeway=self._leeway,
                options={"require": ["exp", "iat", "iss", "aud", "sub"]},
            )
            return claims
        except jwt.PyJWKClientConnectionError as exc:
            raise ApiError(
                ErrorCode.DEPENDENCY_UNAVAILABLE, "Identity provider keys are unavailable."
            ) from exc
        except jwt.PyJWTError as exc:
            raise ApiError(ErrorCode.UNAUTHENTICATED) from exc


@lru_cache(maxsize=1)
def get_token_verifier() -> TokenVerifier:
    settings = get_settings()
    return TokenVerifier(
        issuer=settings.oidc_issuer,
        audience=settings.oidc_audience,
        jwk_client=jwt.PyJWKClient(settings.oidc_internal_jwks_url, cache_keys=True, timeout=5),
        leeway=settings.oidc_clock_skew_seconds,
    )


_bearer = HTTPBearer(auto_error=False)


def current_user(
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
    verifier: Annotated[TokenVerifier, Depends(get_token_verifier)],
) -> CurrentUser:
    if credentials is None or credentials.scheme.lower() != "bearer":
        raise ApiError(ErrorCode.UNAUTHENTICATED)
    claims = verifier.verify(credentials.credentials)
    try:
        resolver = ports.get(PrincipalResolver)
    except ports.PortNotProvided as exc:
        raise ApiError(ErrorCode.DEPENDENCY_UNAVAILABLE, "Identity module is not installed.") from exc
    return resolver.resolve(claims, correlation_id())


current_principal = current_user
CurrentUserDep = Annotated[CurrentUser, Depends(current_user)]
