"""JWT helpers for tests: a fake Keycloak issuer with an in-memory RSA key."""

import base64
import hashlib
import hmac
import json
import time
from types import SimpleNamespace
from typing import Any

import jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa


class StaticJwkClient:
    def __init__(self, public_key: Any, kid: str, *, fail: Exception | None = None) -> None:
        self._public_key = public_key
        self._kid = kid
        self._fail = fail

    def get_signing_key_from_jwt(self, token: str) -> Any:
        if self._fail is not None:
            raise self._fail
        if jwt.get_unverified_header(token).get("kid") != self._kid:
            raise jwt.PyJWKClientError("Unable to find a signing key that matches")
        return SimpleNamespace(key=self._public_key)


class FakeIssuer:
    def __init__(
        self,
        issuer: str = "http://localhost:21051/auth/realms/nais",
        audience: str = "nais-api",
        kid: str = "test-key",
    ) -> None:
        self.issuer = issuer
        self.audience = audience
        self.kid = kid
        self.private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)

    def token(self, *, expires_in: int = 300, **claims: Any) -> str:
        now = int(time.time())
        payload = {
            "iss": self.issuer, "aud": self.audience, "sub": "kc-user-1", "iat": now, "exp": now + expires_in,
            "sid": "session-1", "email": "a.researcher@inst-a.local", "name": "A Researcher", "org_code": "inst-a",
        }
        payload.update(claims)
        return jwt.encode(payload, self.private_key, algorithm="RS256", headers={"kid": self.kid})

    def jwk_client(self, *, fail: Exception | None = None) -> StaticJwkClient:
        return StaticJwkClient(self.private_key.public_key(), self.kid, fail=fail)

    def public_pem(self) -> bytes:
        return self.private_key.public_key().public_bytes(
            serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo
        )


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


def forge_hs256(payload: dict[str, Any], secret: bytes, kid: str) -> str:
    """Build an HS256 token by hand (PyJWT refuses PEM secrets) to test algorithm-confusion defenses."""
    header = _b64(json.dumps({"alg": "HS256", "typ": "JWT", "kid": kid}).encode())
    body = _b64(json.dumps(payload).encode())
    signature = hmac.new(secret, f"{header}.{body}".encode(), hashlib.sha256).digest()
    return f"{header}.{body}.{_b64(signature)}"
