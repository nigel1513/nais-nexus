"""UUIDv7 generation (RFC 9562). Python 3.13 has no uuid.uuid7()."""

import os
import time
import uuid

_MASK_48 = (1 << 48) - 1
_MASK_62 = (1 << 62) - 1


def new_id() -> uuid.UUID:
    unix_ms = time.time_ns() // 1_000_000
    rand = int.from_bytes(os.urandom(10), "big")
    value = (unix_ms & _MASK_48) << 80
    value |= 0x7 << 76
    value |= (rand >> 68) << 64
    value |= 0b10 << 62
    value |= rand & _MASK_62
    return uuid.UUID(int=value)
