# NAIS UI 디자인 시스템 — 방향 A "차분한 연구 도구"

- 날짜: 2026-10-01
- 대상: `apps/web` 전 화면, `packages/ui` 공통 부품
- 사용자 결정: 레퍼런스 3안(https://claude.ai/artifact/PQnqyQULwadNWNh9VHfLBe) 중 **A. 차분한 연구 도구**. 요구: "LLM이 대충 만든 느낌이 나지 않게", 외부 레퍼런스를 제대로 참조, 연구자가 매일 쓰는 도구로서 직관적이고 멋지게.
- 근거 자료: 설치된 UI 스킬(emil-design-eng, apple-design, pick-ui-library, animate, review-animations/STANDARDS, mobile-native, ask-sonner, motion), Vercel Geist(색 10단계 역할, 타입 클래스 체계), Linear(재설계 글: 크롬 최소화·정렬·밀도·대비 변수), Hugging Face Data Studio(열 머리 분포, 100행 페이지, 막대 클릭 필터), Radix Colors(12단계 역할, 11·12단계 APCA 대비 보장), Pretendard(OFL, npm `pretendard`).

## 1. 원칙

1. **데이터가 주인공, 크롬은 조연.** 회색 계열 바탕과 1px 경계선으로 구조를 만들고, 색은 상태와 선택에만 쓴다(Linear: "chrome 사용량을 줄여 중립적이고 오래가는 인상"). 한 화면에 채도 있는 색은 포인트(인디고) + 상태색 1~2개까지.
2. **정보 밀도는 높게, 위계는 분명하게.** 표·수치·경로가 많다. 본문 14px, 표 13px, 고정폭 숫자(tabular-nums)와 모노 글꼴로 정렬. 위계는 크기보다 **굵기·색 단계·간격**으로 만든다(apple-design §15).
3. **모든 값은 토큰에서.** 간격·반경·색·그림자·움직임은 아래 토큰만 쓴다. 임의 px, 임의 hex 금지(리뷰에서 차단). "Nothing is random — every spacing, timing, and alignment value is a deliberate choice."
4. **응답은 즉시, 움직임은 이유가 있을 때만.** 누름 피드백은 pointer-down에서 즉시, UI 애니메이션 ≤ 250ms, 하루 수십~수백 번 쓰는 동작(⌘K, 탭 전환, 목록 이동)에는 애니메이션 없음(emil 빈도표).
5. **길찾기(wayfinding).** 모든 화면이 "어디에 있나(브레드크럼·사이드바 활성) / 어디로 갈 수 있나 / 무엇이 있나 / 어떻게 나가나"에 답한다.
6. **한국어 우선 타이포그래피.** Pretendard 가변 글꼴, 한글 본문 행간 1.6, 제목은 음의 자간.

### "LLM이 만든 느낌" 금지 목록 (리뷰 차단 항목)

| 금지 | 대신 |
|---|---|
| 그라데이션 배경·텍스트, 장식용 블롭/글로우 | 단색 면 + 1px 경계 |
| 이모지 아이콘, 장식 일러스트 | lucide 아이콘 16px(stroke 1.75), 의미 있는 곳에만 |
| 모든 것을 카드로 감싸는 "카드 수프", 카드 안의 카드 | 섹션 제목 + 구분선, 카드는 독립 개체(목록 항목·요약 패널)에만 |
| 왼쪽 굵은 색 띠 카드(border-left 강조) | 상태 배지 또는 아이콘 + 텍스트 |
| 모서리 반경 혼용(4/8/12/16/24가 섞임) | §2.5의 3단계만 |
| 큰 둥근 pill 버튼, 중앙 정렬 히어로, "Welcome back!" 류 문구 | 좌측 정렬 페이지 헤더, 구체적 제목·동사 |
| 회색 위 회색 저대비 캡션 | 텍스트는 slate-11 이상(대비 ≥ 4.5:1) |
| Inter/Roboto/Arial 기본값, 시스템 기본 select/checkbox 그대로 | Pretendard + JetBrains Mono, 공통 부품 |
| `transition: all`, `scale(0)` 등장, ease-in | 속성 명시, scale(0.97)+opacity, 강한 ease-out |
| 의미 없는 그림자 남발, 3단 이상 깊이 | 그림자는 떠 있는 레이어(팝오버·다이얼로그·토스트)에만 |
| 장황한 설명문·마케팅 톤 | 짧은 라벨, 숫자·상태 우선, 도움말은 툴팁/보조 텍스트 |

## 2. 토큰

`apps/web/src/app/globals.css`의 Tailwind v4 `@theme`에 CSS 변수로 둔다. 다크 모드는 `next-themes`의 `class` 전략(`.dark` 클래스), 기본값은 시스템 설정.

### 2.1 색 — 기초 스케일 (Radix Colors 3.0, 12단계)

중립: **slate**, 포인트: **indigo**, 상태: **grass**(성공), **amber**(경고), **red**(위험), **teal**(정보·데이터 시각화 2색).

| 단계 | slate light | slate dark | indigo light | indigo dark |
|---|---|---|---|---|
| 1 | #fcfcfd | #111113 | #fdfdfe | #11131f |
| 2 | #f9f9fb | #18191b | #f7f9ff | #141726 |
| 3 | #f0f0f3 | #212225 | #edf2fe | #182449 |
| 4 | #e8e8ec | #272a2d | #e1e9ff | #1d2e62 |
| 5 | #e0e1e6 | #2e3135 | #d2deff | #253974 |
| 6 | #d9d9e0 | #363a3f | #c1d0ff | #304384 |
| 7 | #cdced6 | #43484e | #abbdf9 | #3a4f97 |
| 8 | #b9bbc6 | #5a6169 | #8da4ef | #435db1 |
| 9 | #8b8d98 | #696e77 | #3e63dd | #3e63dd |
| 10 | #80838d | #777b84 | #3358d4 | #5472e4 |
| 11 | #60646c | #b0b4ba | #3a5bc7 | #9eb1ff |
| 12 | #1c2024 | #edeef0 | #1f2d5c | #d6e1ff |

| 상태 | light 3 / 6 / 9 / 11 | dark 3 / 6 / 9 / 11 |
|---|---|---|
| grass | #e9f6e9 / #b2ddb5 / #46a758 / #2a7e3b | #1b2a1e / #2d5736 / #46a758 / #71d083 |
| amber | #fff7c2 / #f3d673 / #ffc53d / **#9e5c00** | #302008 / #5c3d05 / #ffc53d / #ffca16 |
| red | #feebec / #fdbdbe / #e5484d / #ce2c31 | #3b1219 / #72232d / #e5484d / #ff9592 |
| teal | #e0f8f3 / #a1ded2 / #12a594 / **#007c6b** | #0d2d2a / #145750 / #12a594 / #0bd8b6 |

light 경고·정보 글자색은 Radix 11단계(#ab6400 4.49:1, #008573 4.45:1)가 `--bg`에서 AA에 못 미쳐 한 단계 어둡게 출시했다(굵게 표시, `tokens.test.ts` 대비 검사).

단계 역할(Radix): 1–2 앱·패널 배경, 3–5 부품 배경(기본/hover/선택), 6–8 경계(장식/상호작용/강한·포커스), 9–10 단색 면(기본/hover), 11 보조 텍스트, 12 본문 텍스트. 11·12단계는 같은 스케일 2단계 배경 위에서 APCA Lc 60 / 90 보장.

### 2.2 의미 토큰 (컴포넌트는 이것만 쓴다)

| 토큰 | light | dark | 용도 |
|---|---|---|---|
| `--bg` | slate-1 | slate-1 | 페이지 바탕 |
| `--bg-subtle` | slate-2 | slate-2 | 사이드바, 표 머리, 코드 블록 |
| `--bg-panel` | #ffffff | slate-2 | 떠 있는 패널·팝오버·다이얼로그 |
| `--bg-hover` | slate-3 | slate-3 | 행/메뉴 hover |
| `--bg-active` | slate-4 | slate-4 | 선택된 내비 항목, 눌림 |
| `--border` | slate-6 | slate-6 | 기본 구분선 |
| `--border-strong` | slate-7 | slate-7 | 입력 경계 |
| `--fg` | slate-12 | slate-12 | 본문 |
| `--fg-muted` | slate-11 | slate-11 | 보조 텍스트(최소 단계) |
| `--fg-subtle` | slate-10 | slate-10 | 비활성·자리표시자(본문용 금지) |
| `--accent` | indigo-9 | indigo-9 | 선택 표시, 링크 밑줄, 차트 1색 |
| `--accent-fg` | indigo-11 | indigo-11 | 링크 텍스트, 선택된 탭 |
| `--accent-soft` | indigo-3 | indigo-3 | 선택된 파일·행 배경 |
| `--primary` | slate-12 | slate-12 | **주 버튼 면** (Vercel/Linear식 잉크색 버튼) |
| `--primary-fg` | #ffffff | slate-1 | 주 버튼 텍스트 |
| `--focus` | indigo-8 | indigo-8 | 포커스 링 |
| `--success-*`, `--warning-*`, `--danger-*`, `--info-*` | 각 상태 스케일 3(면)/6(경계)/11(텍스트) | 동일 | 배지·알림 |

주 버튼은 잉크색(slate-12)이다. 인디고는 "선택·링크·데이터"를 뜻하는 정보 색으로만 쓰고 버튼 면에 쓰지 않는다. 그래서 화면 전체가 차분하고, 인디고가 나타나는 곳이 곧 "선택된 것/눌러서 이동하는 것"이 된다.

### 2.3 타이포그래피

- 글꼴: `--font-sans: "Pretendard Variable", Pretendard, -apple-system, BlinkMacSystemFont, system-ui, "Apple SD Gothic Neo", "Noto Sans KR", sans-serif;` — npm `pretendard`의 `dist/web/variable/pretendardvariable-dynamic-subset.css`를 앱에서 import(자체 호스팅, OFL).
- 모노: `--font-mono: "JetBrains Mono Variable", ui-monospace, SFMono-Regular, Menlo, monospace;` — npm `@fontsource-variable/jetbrains-mono`. 파일 경로, ID, 해시, 열 이름, 수치 표.
- 렌더링: 본문에 `font-feature-settings: "ss06"`(Pretendard 'High legibility', l/I/1 구분)과 `text-rendering: geometricPrecision`. 후자가 없으면 Linux Chromium이 12–13px·500에서 글자 폭을 정수로 반올림해 "flo at64"처럼 간격이 벌어진다.
- 숫자: 표·통계·크기에는 `font-variant-numeric: tabular-nums;` 유틸리티 `.num`.

| 토큰 | 크기/행간 | 굵기 | 자간 | 용도 |
|---|---|---|---|---|
| `text-display` | 28/34 | 650 | -0.02em | 데이터셋·프로젝트 제목(페이지 h1) |
| `text-title` | 20/28 | 600 | -0.015em | 섹션 제목(h2) |
| `text-heading` | 16/24 | 600 | -0.01em | 카드·패널 제목(h3) |
| `text-body` | 14/22 | 400 | 0 | 본문 기본 |
| `text-body-strong` | 14/22 | 550 | 0 | 강조 라벨 |
| `text-small` | 13/20 | 400 | 0 | 표 셀, 메타 정보 |
| `text-caption` | 12/16 | 500 | 0.01em | 열 머리, 배지, 보조 라벨 |
| `text-mono` | 12.5/20 | 450 | 0 | 경로·ID·수치 |
| `text-micro` | 11/14 | 500 | 0 | Kbd, 20·24px 아바타 이니셜 |
| 장문(About 마크다운) | 15/26 | 400 | 0 | 설명 본문, 최대 폭 72ch |

### 2.4 간격 (4px 기반)

`0.5=2, 1=4, 1.5=6, 2=8, 3=12, 4=16, 5=20, 6=24, 8=32, 10=40, 12=48, 16=64`. 페이지 좌우 여백 32px(≥1280), 24px(≥768), 16px(모바일). 섹션 간 32px, 섹션 제목–내용 12px, 폼 필드 간 16px, 표 셀 패딩 8×12px.

### 2.5 반경·경계·그림자·z-index

- 반경 3단계만: `--radius-sm: 6px`(버튼·입력·배지·메뉴 항목), `--radius-md: 10px`(카드·패널·팝오버·표 외곽), `--radius-lg: 14px`(다이얼로그·시트). 원(아바타·라디오·스위치·상태 점)은 반경 단계가 아니다. 예외는 4px 토큰 하나(`--radius-xs`, `rounded-xs`): 키캡(Kbd), 16px 체크박스, 6px 틀 안 2px 여백에 놓인 SegmentedControl 칸(동심 반경 6−2), Tag 제거 버튼, PathText 포커스 외곽선.
- 경계: 1px `--border`. 입력·체크박스는 `--border-strong`. 구분은 그림자 대신 경계로.
- 그림자(떠 있는 레이어 전용): `--shadow-popover: 0 1px 2px rgb(0 0 0 / .04), 0 8px 24px -6px rgb(0 0 0 / .16)`; `--shadow-dialog: 0 1px 2px rgb(0 0 0 / .06), 0 24px 48px -12px rgb(0 0 0 / .28)`. dark에서는 그림자 대신 `--bg-panel` + 1px `--border` 위주.
- z-index: `base 0, sticky 10, sidebar 20, header 30, popover 50, dialog 50, toast 60, tooltip 70`. CSS 변수 `--z-sticky/-sidebar/-header/-popover/-dialog/-toast/-tooltip`로 두고 부품은 `z-[var(--z-…)]`만 쓴다. 팝오버는 대화상자와 같은 층(50)이다: 대화상자 안에서 연 Select·메뉴가 DOM에서 뒤에 오므로 위에 그려진다(40이면 대화상자 아래로 숨는다).
- 추가 토큰(Task 2): `--color-danger-fill/-hover/-fg`(채운 위험 버튼, 흰 글자 light 5.2:1·dark 5.6:1 — red-9 위 흰 글자는 3.9:1이라 쓰지 않음), `--color-bg-raised` + `--shadow-raised`(SegmentedControl 선택 칸), `--color-switch-thumb`, `--color-scrim`(대화상자·시트 배경, light 40%·dark 60%), `--dur-exit: 100ms`(팝오버 퇴장). `.light` 블록은 다크 페이지 안에서 하위 트리를 라이트로 고정한다(갤러리용, `@theme`과 같은 값을 테스트로 확인).
- `--fg-subtle`(slate-10)은 자리표시자·비활성·장식 전용(light 3.7:1).

### 2.6 움직임

```css
--ease-out: cubic-bezier(0.23, 1, 0.32, 1);
--ease-in-out: cubic-bezier(0.77, 0, 0.175, 1);
--ease-drawer: cubic-bezier(0.32, 0.72, 0, 1);
--dur-press: 120ms;  --dur-fast: 150ms;  --dur-base: 200ms;  --dur-sheet: 280ms;
```

| 요소 | 동작 |
|---|---|
| 버튼·클릭 가능한 행·칩 | `:active { transform: scale(0.97) }`, `transition: transform var(--dur-press) var(--ease-out)` |
| 툴팁 | 첫 표시 지연 500ms, 이후 인접 툴팁은 지연·애니메이션 0(`data-instant`). 125ms opacity+scale(0.97) |
| 팝오버·메뉴·셀렉트 | 150ms, `transform-origin: var(--transform-origin)`, scale(0.97)+opacity에서 등장, 퇴장은 100ms |
| 다이얼로그 | 200ms ease-out, 중앙 기준 scale(0.98)+opacity, 배경 scrim 150ms |
| 모바일 사이드바·시트 | 280ms `--ease-drawer`, translateX(-100%)↔0, 같은 방향으로 퇴장 |
| 토스트 | Sonner 기본(전환 기반, 끼어들기 가능) |
| ⌘K 명령 팔레트, 탭 전환, 목록 키보드 이동 | **애니메이션 없음** |
| 목록 첫 로드 | 스켈레톤 → 내용 교체(페이드 120ms), 스태거 금지(업무 화면) |
| hover 효과 | `@media (hover: hover) and (pointer: fine)` 안에만 |
| `prefers-reduced-motion: reduce` | transform 제거, opacity만 120ms |

애니메이션 대상 속성은 `transform`, `opacity`(필요 시 `clip-path`)만. `transition: all` 금지.

## 3. 앱 셸

```
┌ 사이드바 240px (bg-subtle) ┬ 상단 바 48px: 브레드크럼 ············ 🔔  ⌘K ┐
│ [N] NAIS Commons           │                                              │
│ [⌘K 검색…            ]     │  페이지 헤더 (h1, 메타, 주 행동)              │
│ ─ 작업                     │  ──────────────────────────────             │
│   대시보드                 │  내용 (최대 폭 1200px, 좌측 정렬)             │
│   프로젝트                 │                                              │
│   데이터                   │                                              │
│   노트북 (예정)            │                                              │
│ ─ 거버넌스                 │                                              │
│   접근 관리       ③        │                                              │
│   활동                     │                                              │
│ ─ 관리 (권한 있을 때)      │                                              │
│   기관                     │                                              │
│ ·························  │                                              │
│ (아바타) B Steward ▾       │                                              │
│  Institute B · 데이터관리자│                                              │
└────────────────────────────┴──────────────────────────────────────────────┘
```

- **사이드바**: 240px, 접기(64px 아이콘 레일, 상태는 localStorage — try/catch). 항목 높이 32px, 아이콘 16px + 라벨 14px/500, 활성 항목은 `--bg-active` + `--fg`, 비활성은 `--fg-muted`. 그룹 라벨 `text-caption` `--fg-subtle`. 접근 관리 옆 숫자는 내가 처리할 요청 수(검토 대기).
- **상단 바**: 48px, 반투명 아님(업무 도구는 불투명이 더 읽기 쉽다; apple-design의 재질 규칙은 시트/팝오버에만). 왼쪽 브레드크럼(마지막 항목 `--fg`, 나머지 `--fg-muted`, 구분자 `/`), 오른쪽 알림 벨(팝오버), ⌘K 버튼.
- **⌘K 명령 팔레트**(cmdk): 데이터셋·프로젝트 검색(서버 검색 debounce 150ms), 화면 이동, 행동(새 데이터셋, 새 프로젝트, 접근 요청 보기, 테마 전환). 단축키 ⌘K/Ctrl+K, `/`로 사이드바 검색 포커스. 열고 닫을 때 애니메이션 없음.
- **사용자 메뉴**(드롭다운): 이름·소속·역할, 설정, 테마(시스템/라이트/다크), 로그아웃. 현재 소속 기관을 메뉴 머리에 표시(기관 전환 기능은 없음 — 표시만).
- **알림 팝오버**: 360px, 읽지 않음 굵게 + 인디고 점, "모두 읽음", 항목 클릭 시 이동. 비었을 때 한 줄 안내.
- **모바일(<768px)**: 사이드바 → 왼쪽 시트(280ms drawer 곡선), 상단 바에 메뉴 버튼, 오른쪽 레일은 본문 아래로. 입력 16px(줌 방지), `100dvh`, 탭 하이라이트 제거, viewport 메타·theme-color 두 개(mobile-native 기준선).

## 4. 부품 목록 (`packages/ui`)

라이브러리(pick-ui-library 큐레이션 목록 기준):
- 접근성 원시 부품: **Base UI** (`@base-ui-components/react` — 설치 시 최신 패키지명 확인) — Dialog, Popover, Menu, Select, Combobox, Tooltip, Tabs, Checkbox, Radio, Switch, Toggle Group. 현재 쓰는 Radix(dialog, tabs)는 이번 재작성에서 Base UI로 교체(한 계열로 통일).
- 명령 팔레트: **cmdk**. 토스트: **Sonner**(헤드리스 래퍼 `notify()`로 디자인 통일). 변형 스타일: **cva** + clsx + tailwind-merge. 다크 모드: **next-themes**. 큰 목록·표 가상화: **react-virtuoso**(1,000행 이상). 대시보드 차트: **recharts**. 열 분포 미니 히스토그램: 자체 SVG(수십 개가 한 화면에 그려지므로 경량) — 목록 밖 결정. 날짜 범위: 큐레이션 목록에 없음 → **react-day-picker**(목록 밖, 사유 명시). 숫자 표시: `Intl.NumberFormat('ko-KR')` + tabular-nums(실시간 카운터가 없어 NumberFlow 불필요).

| 부품 | 변형/크기 | 상태·규칙 |
|---|---|---|
| Button | `primary`(잉크), `secondary`(흰 면+경계), `ghost`, `danger`; `sm 28px`, `md 32px`(기본), `lg 40px`; 아이콘 16px, 간격 6px | hover 면 1단계 진하게, `:active scale(.97)`, disabled 50% 불투명·커서 금지, loading 시 폭 유지+스피너 |
| IconButton | 28/32px 정사각, `aria-label` 필수 | 툴팁 자동 연결 |
| Input / Textarea | 높이 32px, 패딩 0 10px, 경계 `--border-strong`, 반경 sm | focus: 경계 `--focus` + 3px `indigo-4` 링, 오류: red-8 경계 + 아래 13px red-11 메시지(`aria-describedby`) |
| Select | Base UI Select, 트리거는 Input과 동일 치수 | 선택 항목 체크 아이콘, 키보드 탐색 |
| Combobox / UserPicker | 입력 + 팝오버 목록, 아바타·이름·소속·NTIS 한 줄 | 선택 후 칩 표시, blur 시 미선택 입력 복원(기존 규칙 유지) |
| VocabularyPicker | 팝오버 안 검색 + 트리(분야>세부), 체크 다중 선택, 상한 도달 시 나머지 비활성 + "최대 N개" 안내 | 선택 결과는 Tag 칩 |
| DateRangePicker | 두 입력(YYYY-MM-DD) + 달력 팝오버(react-day-picker) | 끝<시작이면 즉시 필드 오류 |
| Checkbox / Radio / Switch | 16px, 선택 시 `--primary` 면 | 라벨 클릭 영역 포함 |
| SegmentedControl | 높이 28px, 바탕 slate-3, 선택 칸 흰 면+그림자 1단 | Data Explorer 보기 전환, 기간 단위 |
| Tabs (밑줄형) | 높이 40px, 라벨 14/500, 선택 시 `--fg` + 2px `--fg` 밑줄, 개수 배지 | URL `?tab=` 동기화, 전환 애니메이션 없음 |
| Badge | `neutral`, `success`, `warning`, `danger`, `info`, `accent`; 높이 20px, 12/500, 반경 sm, 면=3단계 글자=11단계 | 점(dot) 변형: 6px 원 + 텍스트 |
| StatusPill | 상태 enum → 색·라벨 매핑 표 하나(접근 요청, 버전, 파일, 검증) | 한 곳에서만 정의 |
| Tag | 경계형 칩 22px, 어휘·키워드 | 제거 버튼(편집 시) |
| Avatar | 20/24/32px, 이니셜(한글 성 1자/영문 2자), 배경은 이름 해시로 slate/indigo/teal/grass/amber 3단계 중 하나 | 사진 없음 |
| Tooltip | 12/16 글자, slate-12 면, 흰 글자, 반경 sm | 지연 규칙 §2.6 |
| Popover / DropdownMenu | 면 `--bg-panel`, 경계, `--shadow-popover`, 반경 md, 항목 32px | 키보드·포커스 반환 |
| Dialog | 폭 480/640px, 반경 lg, 헤더(제목+설명)·본문·푸터(오른쪽 정렬: 취소 secondary, 확인 primary/danger) | 위험 행동만 확인 대화상자 |
| Sheet | 오른쪽 480px(상세 편집), 모바일 왼쪽 내비 | 같은 방향 퇴장 |
| Toast (Sonner) | 오른쪽 아래, 헤드리스 래퍼로 아이콘·색 통일, 오류 토스트는 닫을 때까지 유지 | 성공 4s |
| DataTable | 행 36px(dense 32px), 머리 sticky `--bg-subtle` 12/500 caption, 정렬 아이콘, 행 hover `--bg-hover`, 숫자 열 오른쪽 정렬 tabular, 선택 행 `--accent-soft` | 1,000행 이상 Virtuoso, 빈 상태 내장 |
| EmptyState | 아이콘 20px 원형 바탕 + 제목 14/600 + 한 줄 설명 + 행동 버튼 1개 | 일러스트 없음 |
| Skeleton | slate-3 면, 실제 레이아웃과 같은 크기 | 깜빡임 없는 은은한 shimmer 금지 → 정적 |
| Progress | 4px 막대, `--accent` | 업로드·검증 |
| Kbd | 모노 11px, 경계 1px, 반경 4px(유일한 예외: 키캡) | ⌘K 표시 |
| Code / PathText | 모노, 긴 경로 가운데 생략 + 전체는 툴팁, 복사 버튼(보안 컨텍스트 아니어도 동작하는 기존 `copyText`) | |
| Stat | 라벨 caption + 값 20/600 tabular + 보조 변화량 | 대시보드·활동 요약 |
| MiniHistogram | SVG, 막대 사이 1px, 기본 slate-8, hover 막대 indigo-9 + 값 툴팁 | 원값 권한 규칙은 데이터 레이어에서 |
| Sparkline | 선 1.5px indigo-9, 영역 채움 없음 | |

## 5. 페이지 템플릿

- **목록 페이지**: 페이지 헤더(제목 display, 한 줄 설명 muted, 오른쪽 주 버튼) → 툴바(검색 입력 320px, 필터 칩들, 정렬, 보기 전환) → 표 또는 결과 목록 → 페이지네이션. 왼쪽 필터 패널이 필요한 검색 화면은 240px 레일.
- **상세 페이지(오른쪽 레일)**: 헤더(브레드크럼은 상단 바, 제목·부제·메타 줄·배지·행동 버튼) → 밑줄 탭 → 본문 그리드 `minmax(0,1fr) 300px`, 간격 32px. 오른쪽 레일은 정보 패널(사람, 정책, 활동) — 각 패널은 제목 caption + 정의 목록, 카드 테두리 1px.
- **폼 페이지**: 폭 720px, 섹션(제목 heading + 설명 small muted, 오른쪽에 필드) 2열 레이아웃(≥1024px: 섹션 설명 240px | 필드), 하단 고정 액션 바(저장 primary, 취소 ghost), 오류 요약은 상단.
- **설정 페이지**: 왼쪽 설정 하위 내비(프로필, 연구자 번호, 테마, 기관 관리), 오른쪽 섹션 카드.

## 6. 화면별 재설계 메모

| 화면 | 지금 | 새 모습 |
|---|---|---|
| 공개 첫 화면 `(public)/page` | 단순 링크 | 좌측 정렬 소개 1단락 + 로그인 버튼 + 연구회 기관 수·데이터셋 수 Stat 3개(수치만, 마케팅 문구 없음) |
| mock-login | 사용자 버튼 목록 | 가운데 420px 패널, 계정 행(아바타·이름·기관·역할 배지), "체험 모드" 배지, 키보드 선택 |
| 대시보드 | 동일 카드 4개 | 상단 Stat 줄(내 프로젝트, 검토 대기, 활성 접근 권한, 곧 만료), 2열: "검토할 요청"(표) / "최근 활동"(타임라인), 아래 "내 데이터셋 최근 버전" 표. 비었을 때 각 블록에 다음 행동 |
| 데이터 검색 | 결과 카드 + 패싯 | 왼쪽 필터 레일(분야·대상·방법 트리 체크, 기관, 기간, 연구책임자, 공개 수준, AI-ready), 상단 검색+정렬+결과 수, 결과는 **행 목록**(제목 16/600 + 부제 + 메타 줄: 기관·책임자·기간·버전·파일 수·용량 + 배지), 표 보기 전환(제목/기관/기간/수정일/AI-ready) |
| 데이터 상세(Data Card) | 현재 Kaggle형 | 레퍼런스 A 그대로: 헤더(제목 display, 부제, 메타 줄, 배지 줄, 행동: 문의·새 노트북·다운로드 primary), 탭(데이터 카드/버전·변경/계보/코드/문의), 본문: About(15/26, 72ch) → Data Explorer(경계 패널: 왼쪽 파일 트리 220px RAW/PROCESSED/DOCS 그룹, 오른쪽 SegmentedControl Detail/Compact/Column, 열 카드 2열 MiniHistogram + 모노 통계, 행 미리보기 DataTable) → 열 설명 DataTable → 메타데이터 정의 목록(140px 라벨). 오른쪽 레일: 담당자, 연구책임자, 이용 정책, 활동 |
| 버전 탭/버전 상세 | 목록 + 파일 | 커밋 이력형 목록(버전 라벨 모노, 변경 메모, 발행자, 날짜, `+2 −1 ~3` 요약 칩), 버전 상세는 파일 DataTable(역할 배지, 크기, 해시 모노 축약+복사, 상태) + 업로드 패널(드롭존 점선 1px, 진행률 Progress) + 발행 체크리스트 |
| 데이터 등록/수정 폼 | 단일 열 | 폼 템플릿 2열 섹션: 기본 정보 / 사람 / 연구 맥락 / 데이터 정보 / 분류(어휘) / 이용 조건 / 관련 논문 |
| 프로젝트 목록 | 카드 | DataTable(이름, 기관 수, 구성원, 데이터셋, 내 역할, 수정일) + 새 프로젝트 |
| 프로젝트 상세 | 탭 | 상세 템플릿: 탭(개요/구성원/데이터/노트북 예정), 구성원 DataTable + 초대 Combobox, 오른쪽 레일: 소유 기관, 기간, 역할 분포 |
| 접근 관리 | 탭 2개 | 탭(검토할 요청 ③/내 요청/내 권한), DataTable(데이터셋, 요청자·기관, 목적, 기간, 상태 StatusPill, 제출일), 행 클릭 → 상세 |
| 접근 요청 상세 | 정보 + 행동 | 왼쪽: 요청 정보 정의 목록 + 이력 타임라인, 오른쪽 레일: 검토 행동(승인 primary/변경 요청/거절 danger, 기간 입력), 결정 시 Dialog |
| 활동(감사) | 타임라인 | 필터 툴바(기간, 행동 종류, 대상) + 날짜 그룹 타임라인(시각 모노 12, 행위자 아바타, 동사구, 대상 링크), 1,000건 이상 Virtuoso |
| 알림 | 벨 팝오버 | §3 알림 팝오버 |
| 설정 | 섹션 | 설정 템플릿: 프로필(이름·이메일 읽기 전용), 연구자 번호(NTIS 입력·저장·삭제), 테마 |
| 기관 관리 | 구성원 + 이동 카드 | 구성원 DataTable(역할 다중 배지, 상태, 편집 메뉴), 플랫폼 관리자 전용 "기관 이동" 섹션(경고 텍스트 + 확인 Dialog) |
| blocked / not-found / 오류 | 기본 문구 | EmptyState 패턴, 코드 모노 표기, 추적 ID 복사, "대시보드로" 버튼 |
| compute / marketplace(예약) | 자리 | 사이드바에서 숨김 유지, 직접 접근 시 "준비 중" EmptyState |

## 7. 접근성

- 텍스트 대비 ≥ 4.5:1(본문 slate-12, 보조 slate-11; slate-10 이하는 비활성·자리표시자만). 24px 이상 ≥ 3:1.
- 포커스: `:focus-visible`에 2px `--focus` 외곽선 + 2px offset(입력은 내부 링). 마우스 클릭에는 링 없음.
- 모든 아이콘 버튼 `aria-label`, 상태는 색 + 텍스트/아이콘(색만으로 구분 금지, 밝기 차이도 확보).
- 키보드: ⌘K, 표 행 Enter로 열기, 메뉴·셀렉트·콤보박스 화살표 탐색, Esc 닫기 후 트리거로 포커스 반환(Base UI 기본).
- 건너뛰기 링크 유지, 랜드마크(nav, main, aside), 페이지마다 h1 하나.
- 기존 테스트가 쓰는 접근 가능한 이름(버튼·탭·영역 라벨)을 바꾸면 테스트도 같은 커밋에서 갱신. e2e axe 검사 통과.

## 8. 완료 기준 (시각 QA 체크리스트)

각 화면 작업은 Playwright로 다음 스크린샷을 남긴다(`.superpowers/sdd/2026-10-01-ui-redesign/shots/<screen>-<w>-<theme>.png`): **1440×900 light, 1440×900 dark, 390×844 light**. 리뷰어는 아래를 확인한다.

1. 토큰 외 값 없음(임의 hex/px — `rg "#[0-9a-fA-F]{3,6}" apps/web/src --glob '!*.test.*'`가 토큰 파일 외 0건).
2. 금지 목록(§1) 위반 없음.
3. 반경 3단계·간격 4px 격자 정렬, 같은 종류 요소의 높이 통일(버튼 32, 입력 32, 표 행 36).
4. 숫자 열 tabular·오른쪽 정렬, 경로·ID 모노.
5. 다크 모드에서 대비·경계 유지, 그림자 의존 없음.
6. 390px에서 가로 스크롤 없음, 사이드바 시트 동작, 입력 16px.
7. 빈 상태·로딩(스켈레톤)·오류 상태 각각 확인.
8. 움직임: 버튼 눌림, 팝오버 원점, ⌘K 무애니메이션, reduced-motion 확인.
9. axe 위반 0, 키보드만으로 주요 흐름(검색 → 상세 → 접근 요청) 완주.
