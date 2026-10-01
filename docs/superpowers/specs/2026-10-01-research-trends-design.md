# 연구 동향 (논문·학회) 설계 — 모듈 M12 Research Trends

- 날짜: 2026-10-01
- 대상: 신규 모듈 M12 `trends`(백엔드), M10 Web(신규 화면 `/commons/trends`)
- 데이터 포털 고도화(Wave 1.5)와 파일이 겹치지 않아 병렬 진행 가능. 계약은 openapi에 별도 태그 `trends`로 추가.

## 1. 목적과 결정 사항 (사용자 대화 2026-10-01)
NST 산하 연구기관 연구자가 로그인해서 **과학기술 분야별로 세계에서 어떤 연구가 화제인지, 어디(저명 학회·저널)에 무슨 논문이 나오는지** 보고, 그 분야에서 **우리 연구회 기관이 어디쯤 있는지** 확인한다.

| # | 결정 |
|---|---|
| T1 | 화면은 **분야별 세계 동향**(주 화면, 1순위)과 **연구회 기관 동향**(2순위)으로 **구분**한다 |
| T2 | 데이터는 **매일 자동 갱신** |
| T3 | 분류는 **논문에 붙은 분류(OpenAlex: domain → field → subfield → topic)** 그대로, 화면에 한국어 이름 병기 |
| T4 | 저명 학회·저널은 **점수가 가장 높은 순으로 자동** 선정. 기본 점수 = IF 환산(OpenAlex `2yr_mean_citedness`, IF와 같은 공식), 보조 = h-index. 관리자 보정 없음 |
| T5 | 유료 논문은 **목록(제목·저자·학회/저널·연도·인용 수·DOI 링크·초록 있으면 초록)**만. 무료 공개본(OA) 링크가 있으면 함께 |
| T6 | 로그인 사용자만 열람(포털 전체 규칙). 기관 권한 구분 없음(공개 학술 메타데이터) |
| T7 | 데이터셋 연구 분야(Wave 1.5 SUBJECT 어휘)와 같은 분류 체계로 연결 가능하게 한다 |

### 범위 밖
- 논문 본문 저장·전문 검색, 유료 DB(Scopus/WoS/JCR) 연동, 관리자 순위 보정(T4), 개인 연구자 성과 평가 지표.

## 2. 데이터 출처
- **OpenAlex API** (CC0 메타데이터). 확인된 사실(2026-10-01 서버에서 직접 호출):
  - 서버에서 접근 가능. NST 기관이 ROR/OpenAlex ID로 식별됨(예: KIST works_count 41,801).
  - 사용량 과금 체계: 응답 헤더 `x-ratelimit-limit-usd: 0.1`(키 없는 일일 한도 $0.10), 목록/그룹 질의 1건 `$0.0001`, 일부 질의 `$0.001`. 키 없이 하루 약 1,000건 수준.
  - **결정**: 무료 API 키를 발급받아 `OPENALEX_API_KEY`(.env, 커밋 금지)로 사용. 키의 일일 한도는 설계 확정 시 운영자가 확인한다. 수집기는 **일일 예산 상한 `TRENDS_DAILY_BUDGET_USD`(기본 0.08)**을 헤더 `x-ratelimit-remaining-usd`로 추적해 넘기 전에 멈추고 다음 날 이어서 한다.
- **DBLP**(보조, CS 학회): OpenAlex에서 학회(conference) 지표가 부족한 컴퓨터과학 세부분야만 학회 목록 보강. 1차 구현은 OpenAlex만, DBLP는 단계 3.
- 저장소형 출처(SSRN, Zenodo, arXiv 등 `type=repository`)는 순위에서 제외(논문 목록에는 표시).

## 3. 데이터 모델 (`trends` 스키마)
| 테이블 | 내용 |
|---|---|
| `taxonomy_nodes` | level(DOMAIN/FIELD/SUBFIELD/TOPIC), openalex_id, parent_id, name_en, **name_ko**(seed 번역; 토픽은 영문 우선, 번역은 점진), works_count |
| `venue_rankings` | subfield_id, source_id, name, type(journal/conference), issn/homepage, score_if(2yr_mean_citedness), h_index, works_in_subfield_2y, rank, snapshot_date |
| `topic_trends` | topic_id, year_month, works_count, growth_ratio(최근 12개월 vs 직전 12개월), snapshot_date |
| `papers` | openalex_id PK, doi, title, abstract(있으면, inverted index 복원), publication_date, venue_id/name, authors(json: 이름·소속 ROR·OpenAlex author id), topic ids, cited_by_count, oa_url, is_oa, updated_at |
| `institutions` | 연구회 기관 ↔ OpenAlex institution id/ROR 매핑(M01 organization_id 연결), seed로 NST 산하 기관 목록 |
| `institution_stats` | institution_id, subfield/topic별 논문 수(최근 1·3년), snapshot_date |
| `sync_runs` | 수집 실행 기록(시작·종료·요청 수·사용 금액·상태·오류) |

보관 정책: `papers`는 분야별 상위·최근 논문만 유지(세부분야당 최근 2년 인용 상위 200 + 최근 90일 신규 상위 200, 연구회 기관 논문은 최근 5년 전부). 나머지는 집계치만.

## 4. 수집 (매일)
- 스케줄러(기존 Dramatiq 주기 작업 구조)에서 매일 **03:00 KST** 실행, 전용 큐 `trends`(readiness처럼 dedicated worker, 동시성 1).
- 단계: (1) 분류 갱신(주 1회) → (2) 세부분야별 venue 순위 → (3) 토픽 추세(group_by 월별) → (4) 세부분야 상위·최근 논문 → (5) 연구회 기관 논문 증분(`from_updated_date`=지난 실행일).
- 증분·멱등: 같은 날 재실행 시 upsert. 예산 초과·429·5xx는 지수 백오프 후 남은 단계를 다음 날로 이월(`sync_runs`에 기록). 실패해도 이전 스냅샷을 계속 제공.
- 우선순위: 연구회 기관이 논문을 낸 세부분야를 먼저 갱신(예산 부족 시 덜 중요한 분야가 하루 늦게 갱신).

## 5. API (태그 `trends`, 모두 로그인 필요)
- `GET /trends/taxonomy?parent_id=` — 분야 트리(한국어 이름, 논문 수)
- `GET /trends/subfields/{id}` — 세부분야 개요: 상위 학회·저널(`sort=if|h_index`), 급상승 토픽, 주목 논문, 연구회 기관 참여 현황
- `GET /trends/topics/{id}` — 토픽 추세(월별), 주요 논문, 참여 연구회 기관·연구자, **관련 데이터셋**(T7, 가시성 D-012 그대로)
- `GET /trends/papers?subfield=&topic=&venue=&institution=&q=&sort=cited|recent` — 논문 목록(커서 페이지)
- `GET /trends/institutions` / `GET /trends/institutions/{id}` — 연구회 기관 동향(T1의 2순위 화면)
- `GET /trends/status` — 마지막 갱신 시각, 다음 갱신 예정, 데이터 출처 표기(CC0, OpenAlex)

## 6. 화면 (M10)
- **분야별 세계 동향 (주 화면 `/commons/trends`)**
  - 왼쪽: 분야 트리(분야 → 세부분야), 검색
  - 세부분야 화면: 상단 요약(최근 2년 논문 수, 성장률) → **저명 학회·저널 Top 20 표**(순위, 이름, 유형 배지, IF 환산, h-index, 이 분야 논문 수; 정렬 전환) → **급상승 토픽**(성장률 막대, 클릭 시 토픽 화면) → **주목 논문**(인용 순/최신 순 탭, 카드: 제목, 저자, 학회·저널, 연도, 인용, DOI·OA 링크, 초록 펼치기) → **이 분야의 연구회 기관**(기관별 논문 수 막대)
  - 토픽 화면: 월별 논문 추세 선 그래프, 주요 논문, 참여 연구회 기관·연구자, 관련 데이터셋 카드
- **연구회 기관 동향 (`/commons/trends/institutions`)**: 기관 목록 → 기관 화면(최근 논문 수, 주요 세부분야·토픽, 많이 실린 학회·저널, 최근 논문 목록)
- 모든 화면 하단에 \"데이터 출처: OpenAlex (CC0) · 마지막 갱신 YYYY-MM-DD HH:mm\" 표시
- mock 모드: 고정 seed(분야 3개, 세부분야 6개, 학회·논문 샘플)로 동일 화면 동작

## 7. 단계
| 단계 | 범위 |
|---|---|
| 1 | 수집기(분류·venue 순위·토픽 추세·상위 논문), 예산 관리, 분야별 세계 동향 화면(세부분야·토픽·논문 목록) |
| 2 | 연구회 기관 매핑·기관 논문 증분 수집, 기관 동향 화면, 세계 동향 화면의 \"연구회 기관 참여\"·관련 데이터셋 연결 |
| 3 | 토픽 한국어 이름 확충, DBLP 학회 보강 |

## 8. 위험·운영
- **외부 의존**: OpenAlex 장애·한도 초과 시 마지막 스냅샷을 \"N일 전 데이터\" 경고와 함께 제공.
- **비용**: 일일 예산 상한으로 과금 초과 방지. API 키는 `.env`에만(공개 저장소, 커밋 금지 — 공인 IP와 같은 규칙).
- **저작권**: 메타데이터(CC0)와 초록만 저장. 초록은 출판사 권리가 있을 수 있어 화면 표시만 하고 내보내기 API는 제공하지 않는다.
- **분류 변화**: OpenAlex가 토픽 체계를 바꾸면 주 1회 분류 갱신에서 반영, 사라진 노드는 비활성 처리.

## 9. 테스트
- 수집기: OpenAlex 응답 fixture로 파싱·upsert·증분·예산 정지·백오프 테스트(네트워크 없이). 실제 API 호출은 수동 스모크 1회.
- API: 권한(로그인), 정렬·필터·페이지, 관련 데이터셋 가시성(D-012).
- 웹: 화면 단위 테스트, mock 계약 테스트, Playwright 스모크(비보안 출처 포함).
