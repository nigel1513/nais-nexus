# ADR 0002 — SeaweedFS replaces MinIO for local/dev storage (D-034)

Status: accepted (2026-09-30)

## Context
The PRD specified MinIO for local/dev institution storage. On 2026-09-30 neither `minio/minio` (Docker Hub) nor
`quay.io/minio/minio` could be resolved, so the dev stack cannot depend on MinIO images.

## Decision
Run one SeaweedFS 4.48 (`chrislusf/seaweedfs:4.48`) S3 server per institution (`storage-a`, `storage-b`, port 8333).
Application code uses only the S3 API (boto3, SigV4, path-style), so production keeps any S3-compatible store.

## Verification
Through an Nginx gateway preserving `Host`: presigned PUT/GET, multipart upload via presigned part URLs, tampered URL → 403,
anonymous GET → 403. The Nginx bucket location must be a regex (`^/nais-inst-a(/|$)`); a trailing-slash prefix location
301-redirects `/nais-inst-a` and sends boto3 into a redirect loop.

## Consequences
No web console in dev (ports 21053/21054 expose the S3 endpoints instead). Credentials are generated into the container
from env at start (`infra/docker/storage/start-storage.sh`).
