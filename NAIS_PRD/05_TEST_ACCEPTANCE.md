# Test & Acceptance Plan

## 1. Test Pyramid
- Unit
- Module integration
- Contract
- Security
- E2E
- Load

## 2. P0 Golden E2E
```text
seed Institute A / Institute B
→ A researcher login
→ create Project
→ invite B researcher
→ B creates Controlled Dataset
→ A discovers metadata
→ A requests access
→ B steward approves 7 days
→ A obtains signed download
→ audit event exists
→ grant revoked
→ next download denied
```

## 3. Contract Tests
각 module의 OpenAPI response가 `contracts`와 일치해야 한다.

## 4. AI-Ready Validation Test Dataset
최소 4 fixtures:
- clean tabular
- missing metadata
- invalid units
- missing provenance

## 5. Performance
- catalog search 10k metadata docs
- API 50 concurrent users
- signed URL generation p95
- readiness 1GB sample async 처리

## 6. CI Gate
- lint
- typecheck
- unit
- contract
- migration dry-run
- security critical tests
- build

## 7. v1.1 참조
- 모듈별 인수 테스트 ID(`Mxx-AT-nn`)는 각 `modules/Mxx_*.md` §12에 있다.
- Seed와 seed 검증: `10_SEED_DATA.md`
- AI-ready fixture 4종의 golden output: `09_AI_READY_RULES.md`
- OPA 정책 단위 테스트: `08_OPA_POLICY.md`
- 모든 E2E/보안 테스트는 gateway `http://localhost:21051`을 통해서만 호출한다.
