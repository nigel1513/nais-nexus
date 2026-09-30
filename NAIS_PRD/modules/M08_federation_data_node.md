# M08 Federation / Data Node (P2)

## Goal
실제 데이터는 기관에 두고 NAIS Control Plane이 metadata/access를 연결.

## Separate service
`services/data-node`

## Responsibilities
- node identity
- storage adapter
- dataset manifest
- metadata sync
- grant validation
- direct transfer endpoint
- audit forwarding
- health

## P2 Demo
Institute A MinIO + Institute B MinIO를 별도 Node로 운영.

## Principle
metadata centrally discoverable, bytes remain at owner.
