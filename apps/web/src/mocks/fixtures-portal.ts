import type { Schemas } from "@/shared/api/types";
import { emptyResearch, hex, ORG, PROJECT, REQUEST, GRANT, sid, USER, DATASET, VERSION } from "./fixtures";
import { profileCsv, type Hint } from "./previews";
import { buildResult } from "./readiness-results";
import type { MockDb, MockUser, StoredDataset, StoredValidation, StoredVersion } from "./types";

/**
 * Portal-volume seed for the running mock app (dev server, e2e, screenshots) — NOT the backend seed mirror.
 *
 * createSeed() mirrors NAIS_PRD/10_SEED_DATA.md and stays the baseline for unit tests. enrichSeed() layers what a
 * council portal looks like a month in: two more institutes, eight more datasets across fields, projects, decided
 * and pending access requests, active and expiring grants, readiness results and 30 days of audit events with a
 * weekday rhythm. The base records keep their ids; only their timestamps move into the past so the month reads
 * as history instead of "everything happened at boot".
 *
 * Kept in its own file on purpose (other tracks edit fixtures.ts). Deterministic: a fixed PRNG seed, times relative
 * to `now` in Asia/Seoul working hours.
 */

export const PORTAL_ORG = { c: sid("000c"), d: sid("000d") } as const;
export const PORTAL_USER = {
  aResearcher2: sid("9a01"),
  bResearcher2: sid("9b01"),
  cResearcher: sid("9c01"),
  cSteward: sid("9c02"),
  dResearcher: sid("9d01"),
  dSteward: sid("9d02"),
  /** Joined last week: no projects, requests, grants or downloads yet (the dashboard's first-day state). */
  dNewcomer: sid("9d03"),
} as const;
export const PORTAL_PROJECT = { materialsAi: sid("9101"), hydrogen: sid("9102"), maintenance: sid("9103") } as const;
export const PORTAL_DATASET = {
  solar: sid("9201"),
  fuelCell: sid("9202"),
  hea: sid("9203"),
  semLabels: sid("9204"),
  spindle: sid("9205"),
  weld: sid("9206"),
  dft: sid("9207"),
  membrane: sid("9208"),
} as const;

const DAY = 86_400_000;
const KST = 9 * 3_600_000;

/** mulberry32: small, fast, deterministic. */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

type DatasetSpec = {
  id: string;
  version: string;
  owner: string;
  title: string;
  subtitle: string;
  level: Schemas["AccessLevel"];
  purposes: Schemas["Purpose"][];
  maxDays: number;
  subjects: string[];
  methods: string[];
  materials: string[];
  label: string;
  createdDaysAgo: number;
  publishedDaysAgo: number;
  frequency: Schemas["UpdateFrequency"];
  description: string;
  keywords: string[];
  provenance: string;
  project: [string, string, string];
  file: string;
  csv: () => string;
  hints: Record<string, Hint>;
  preview: "READY" | "PENDING" | "FAILED";
  readiness: Record<string, [Schemas["ReadinessCheckStatus"], string, Record<string, unknown>?]>;
};

const pad = (n: number, w: number) => String(n).padStart(w, "0");
const table = (header: string[], n: number, row: (i: number) => (string | number)[]) => [header.join(","), ...Array.from({ length: n }, (_, i) => row(i).join(","))].join("\n");

const SPECS: DatasetSpec[] = [
  {
    id: PORTAL_DATASET.solar,
    version: sid("9301"),
    owner: ORG.a,
    title: "태양광 모듈 옥외 열화 계측 데이터",
    subtitle: "결정질 실리콘 모듈 24장의 3년간 발전량·모듈 온도·일사량",
    level: "PUBLIC",
    purposes: ["ACADEMIC_RESEARCH", "AI_TRAINING", "EDUCATION", "PUBLIC_INTEREST"],
    maxDays: 365,
    subjects: ["ENERGY", "ENVIRONMENT"],
    methods: ["SENSOR_LOGGING"],
    materials: ["SEMICONDUCTOR"],
    label: "v1.2",
    createdDaysAgo: 210,
    publishedDaysAgo: 8,
    frequency: "QUARTERLY",
    description: "대전 옥외 시험장에 설치한 결정질 실리콘 모듈 24장의 10분 간격 발전량, 모듈 후면 온도, 경사면 일사량을 3년간 기록했다. 연간 열화율 추정과 이상 모듈 탐지 연구에 쓸 수 있다.",
    keywords: ["photovoltaic", "degradation", "outdoor-test", "irradiance"],
    provenance: "한국에너지기술연구원 옥외 시험장 데이터로거(10분 간격)에서 수집, 분기마다 결측 구간을 표시해 공개.",
    project: ["태양광 발전 설비 장기 신뢰성 평가", "NST-2024-0133", "국가과학기술연구회"],
    file: "data/pv_modules.csv",
    csv: () => table(["module_id", "recorded_at", "power_w", "module_temp_c", "irradiance_w_m2"], 600, (i) => [`M${pad((i % 24) + 1, 2)}`, `2026-0${(Math.floor(i / 120) % 6) + 1}-${pad((Math.floor(i / 24) % 27) + 1, 2)}T${pad(9 + (i % 8), 2)}:00:00`, (310 - (i % 24) * 1.6 + ((i * 13) % 40)).toFixed(1), (28 + ((i * 7) % 23) * 0.9).toFixed(1), (520 + ((i * 31) % 480)).toFixed(0)]),
    hints: { power_w: { type: "number", unit: "W", description: "모듈 출력" }, module_temp_c: { type: "number", unit: "Cel", description: "모듈 후면 온도" }, irradiance_w_m2: { type: "number", unit: "W/m2", description: "경사면 일사량" } },
    preview: "READY",
    readiness: {},
  },
  {
    id: PORTAL_DATASET.fuelCell,
    version: sid("9302"),
    owner: ORG.a,
    title: "수소 연료전지 스택 운전 로그",
    subtitle: "5 kW급 PEMFC 스택 2기의 부하 변동 운전 1,200시간",
    level: "CONTROLLED",
    purposes: ["ACADEMIC_RESEARCH", "AI_TRAINING"],
    maxDays: 120,
    subjects: ["ENERGY", "CHEMISTRY"],
    methods: ["SENSOR_LOGGING", "ELECTROCHEM_CYCLING"],
    materials: ["POLYMER_MEMBRANE", "CATALYST"],
    label: "v2.0",
    createdDaysAgo: 150,
    publishedDaysAgo: 15,
    frequency: "MONTHLY",
    description: "고분자전해질 연료전지(PEMFC) 스택 2기를 실제 부하 패턴으로 운전하며 셀 전압, 스택 온도, 수소 이용률을 1초 간격으로 기록한 로그다. 열화 진단과 운전 최적화 모델 학습에 쓴다.",
    keywords: ["fuel-cell", "PEMFC", "hydrogen", "durability"],
    provenance: "스택 시험 설비 제어기 로그를 1분 평균으로 줄여 정리. 시험 중단 구간은 결측으로 남김.",
    project: ["수소 연료전지 내구성 향상 기술", "NST-2025-0210", "산업통상자원부"],
    file: "data/stack_log.csv",
    csv: () => table(["stack_id", "elapsed_h", "cell_voltage_v", "stack_temp_c", "h2_utilization"], 800, (i) => [`S${(i % 2) + 1}`, (i * 1.5).toFixed(1), i % 37 === 0 ? "" : (0.71 - i * 0.00004 + ((i * 11) % 9) * 0.002).toFixed(4), (64 + ((i * 3) % 12) * 0.5).toFixed(1), (0.78 + ((i * 7) % 10) * 0.01).toFixed(2)]),
    hints: { cell_voltage_v: { type: "number", unit: "V", description: "평균 셀 전압" }, stack_temp_c: { type: "number", unit: "Cel", description: "스택 온도" } },
    preview: "READY",
    readiness: { "data.missing_values": ["WARNING", "결측 비율이 기준(2%)을 넘는 열이 있습니다.", { columns: ["cell_voltage_v"], ratio: 0.027 }] },
  },
  {
    id: PORTAL_DATASET.hea,
    version: sid("9303"),
    owner: ORG.b,
    title: "고엔트로피 합금 인장시험 결과",
    subtitle: "CoCrFeMnNi 계열 조성 36종의 상온·고온 인장 물성",
    level: "PUBLIC",
    purposes: ["ACADEMIC_RESEARCH", "AI_TRAINING", "EDUCATION", "PUBLIC_INTEREST"],
    maxDays: 365,
    subjects: ["MATERIALS", "MECHANICAL"],
    methods: [],
    materials: ["METAL_ALLOY"],
    label: "v1",
    createdDaysAgo: 9,
    publishedDaysAgo: 3,
    frequency: "ONCE",
    description: "CoCrFeMnNi 기반 고엔트로피 합금 36개 조성을 아크 용해로 제조해 상온과 600 ℃에서 인장시험한 항복강도, 인장강도, 연신율을 정리했다.",
    keywords: ["high-entropy-alloy", "tensile", "mechanical-properties"],
    provenance: "한국재료연구원 구조재료실 만능시험기(100 kN)로 조성당 3회 시험한 평균값.",
    project: ["고엔트로피 합금 설계 데이터 구축", "NST-2026-0301", "국가과학기술연구회"],
    file: "data/tensile.csv",
    csv: () => table(["alloy_id", "test_temp_c", "yield_mpa", "uts_mpa", "elongation_pct"], 72, (i) => [`HEA-${pad((i % 36) + 1, 2)}`, i < 36 ? 25 : 600, (280 + ((i * 17) % 160)).toFixed(0), (560 + ((i * 23) % 220)).toFixed(0), (32 + ((i * 5) % 28) * 0.8).toFixed(1)]),
    hints: { yield_mpa: { type: "number", unit: "MPa", description: "항복강도" }, uts_mpa: { type: "number", unit: "MPa", description: "인장강도" }, elongation_pct: { type: "number", unit: "%", description: "연신율" } },
    preview: "READY",
    readiness: {},
  },
  {
    id: PORTAL_DATASET.semLabels,
    version: sid("9304"),
    owner: ORG.b,
    title: "이차전지 양극재 SEM 이미지 라벨셋",
    subtitle: "NCM 양극재 입자 SEM 영상 4,800장과 균열·응집 라벨",
    level: "CONTROLLED",
    purposes: ["ACADEMIC_RESEARCH", "AI_TRAINING"],
    maxDays: 90,
    subjects: ["MATERIALS", "BATTERY", "AI_DATA"],
    methods: ["SEM"],
    materials: ["CATHODE"],
    label: "v1.1",
    createdDaysAgo: 64,
    publishedDaysAgo: 11,
    frequency: "IRREGULAR",
    description: "충방전 전후 NCM 양극재 입자의 SEM 영상에 균열, 응집, 표면 잔류물 라벨을 붙인 학습용 데이터셋이다. 라벨 목록과 영상 메타데이터를 표로 함께 제공한다.",
    keywords: ["SEM", "cathode", "segmentation", "labels"],
    provenance: "주사전자현미경(가속전압 5 kV) 영상을 연구원 2명이 교차 라벨링, 불일치 건은 책임연구자가 판정.",
    project: ["차세대 이차전지 수명 예측 연구", "NST-2026-0101", "국가과학기술연구회"],
    file: "data/labels.csv",
    csv: () => table(["image_id", "magnification", "label", "area_um2"], 400, (i) => [`IMG${pad(i, 5)}`, [5000, 10000, 20000][i % 3]!, ["crack", "agglomerate", "residue", "clean"][i % 4]!, (0.4 + ((i * 19) % 50) * 0.11).toFixed(2)]),
    hints: { area_um2: { type: "number", unit: "um2", description: "라벨 영역 넓이" } },
    preview: "PENDING",
    readiness: { "semantics.mapping_status": ["WARNING", "라벨 값이 통제 어휘에 연결되지 않았습니다.", { unmapped: ["label"] }] },
  },
  {
    id: PORTAL_DATASET.spindle,
    version: sid("9305"),
    owner: PORTAL_ORG.c,
    title: "공작기계 스핀들 진동·온도 데이터",
    subtitle: "5축 가공기 스핀들 3대의 가공 중 진동·베어링 온도",
    level: "CONTROLLED",
    purposes: ["ACADEMIC_RESEARCH", "AI_TRAINING"],
    maxDays: 90,
    subjects: ["MECHANICAL", "AI_DATA"],
    methods: ["SENSOR_LOGGING"],
    materials: [],
    label: "v1",
    createdDaysAgo: 33,
    publishedDaysAgo: 5,
    frequency: "MONTHLY",
    description: "5축 가공기 스핀들 3대에 가속도계와 열전대를 붙여 가공 중 진동 RMS와 베어링 온도를 수집했다. 베어링 손상 전후 구간이 표시되어 예지보전 모델 학습에 쓸 수 있다.",
    keywords: ["spindle", "vibration", "predictive-maintenance"],
    provenance: "한국기계연구원 스마트제조 시험장 PLC와 진동 수집기(25.6 kHz)를 1초 통계로 요약.",
    project: ["제조 설비 예지보전 데이터 연계", "NST-2026-0407", "국가과학기술연구회"],
    file: "data/spindle.csv",
    csv: () => table(["spindle_id", "recorded_at", "vibration_rms_g", "bearing_temp_c", "rpm"], 700, (i) => [`SP-${(i % 3) + 1}`, `2026-08-${pad((Math.floor(i / 30) % 28) + 1, 2)}T${pad(8 + (i % 10), 2)}:${pad((i * 7) % 60, 2)}:00`, (0.12 + ((i * 7) % 30) * 0.004).toFixed(3), (41 + ((i * 3) % 19) * 0.6).toFixed(1), [8000, 12000, 15000][i % 3]!]),
    hints: { vibration_rms_g: { type: "number", unit: "[g]", description: "진동 RMS" }, bearing_temp_c: { type: "number", unit: "Cel", description: "베어링 온도" } },
    preview: "READY",
    readiness: {},
  },
  {
    id: PORTAL_DATASET.weld,
    version: sid("9306"),
    owner: PORTAL_ORG.c,
    title: "용접 비드 형상 측정 데이터",
    subtitle: "강판 맞대기 용접 비드 1,200개의 폭·높이·용입 깊이",
    level: "PUBLIC",
    purposes: ["ACADEMIC_RESEARCH", "EDUCATION", "PUBLIC_INTEREST"],
    maxDays: 365,
    subjects: ["MECHANICAL", "MATERIALS"],
    methods: ["OPTICAL_IMAGING"],
    materials: ["STEEL"],
    label: "v1",
    createdDaysAgo: 40,
    publishedDaysAgo: 19,
    frequency: "ONCE",
    description: "로봇 아크 용접 조건(전류, 속도, 와이어 송급)을 바꿔 가며 만든 비드 1,200개의 단면을 측정했다.",
    keywords: ["welding", "bead-geometry", "steel"],
    provenance: "레이저 형상 측정기와 단면 광학 영상에서 비드 치수를 추출.",
    project: ["지능형 용접 품질 예측", "NST-2025-0512", "산업통상자원부"],
    file: "data/beads.csv",
    csv: () => table(["bead_id", "current_a", "speed_mm_s", "width_mm", "penetration_mm"], 300, (i) => [`B${pad(i, 4)}`, 180 + (i % 6) * 20, (6 + (i % 5) * 1.5).toFixed(1), (7.5 + ((i * 7) % 20) * 0.1).toFixed(2), (2.1 + ((i * 11) % 15) * 0.08).toFixed(2)]),
    hints: { current_a: { type: "number", unit: "amp", description: "용접 전류" }, speed_mm_s: { type: "number", unit: "mm/sec", description: "용접 속도" } },
    preview: "READY",
    readiness: { "semantics.units_codebook": ["FAIL", "UCUM 단위가 아닌 값이 있습니다.", { invalid: 2, fields: ["current_a", "speed_mm_s"] }] },
  },
  {
    id: PORTAL_DATASET.dft,
    version: sid("9307"),
    owner: PORTAL_ORG.d,
    title: "촉매 후보 물질 DFT 계산 결과",
    subtitle: "전이금속 합금 표면 2,400개의 흡착 에너지(DFT)",
    level: "PUBLIC",
    purposes: ["ACADEMIC_RESEARCH", "AI_TRAINING", "EDUCATION", "PUBLIC_INTEREST"],
    maxDays: 365,
    subjects: ["CHEMISTRY", "AI_DATA"],
    methods: ["SIMULATION_DFT"],
    materials: ["CATALYST", "METAL_ALLOY"],
    label: "v3",
    createdDaysAgo: 300,
    publishedDaysAgo: 1,
    frequency: "QUARTERLY",
    description: "이원계 전이금속 합금 표면에서 CO, H, O 흡착 에너지를 제일원리 계산(DFT, PBE)으로 구한 값이다. 촉매 탐색용 기계학습 모델의 학습·평가 데이터로 쓴다.",
    keywords: ["DFT", "catalyst", "adsorption-energy", "materials-informatics"],
    provenance: "VASP 6.4, PBE 범함수, 컷오프 450 eV로 계산한 결과를 자동 파이프라인으로 수집.",
    project: ["AI 촉매 탐색 플랫폼", "NST-2025-0920", "과학기술정보통신부"],
    file: "data/adsorption.csv",
    csv: () => table(["surface_id", "adsorbate", "facet", "e_ads_ev"], 500, (i) => [`SURF-${pad(i, 4)}`, ["CO", "H", "O"][i % 3]!, ["111", "100", "211"][(i >> 1) % 3]!, (-0.4 - ((i * 13) % 50) * 0.031).toFixed(3)]),
    hints: { e_ads_ev: { type: "number", unit: "eV", description: "흡착 에너지" } },
    preview: "READY",
    readiness: {},
  },
  {
    id: PORTAL_DATASET.membrane,
    version: sid("9308"),
    owner: PORTAL_ORG.d,
    title: "고분자 전해질막 수분 흡수 시험",
    subtitle: "술폰화 고분자 막 18종의 온습도별 함수율·팽윤",
    level: "CONTROLLED",
    purposes: ["ACADEMIC_RESEARCH"],
    maxDays: 120,
    subjects: ["CHEMISTRY", "ENERGY"],
    methods: [],
    materials: ["POLYMER_MEMBRANE"],
    label: "v1",
    createdDaysAgo: 45,
    publishedDaysAgo: 24,
    frequency: "ONCE",
    description: "연료전지·수전해용 술폰화 고분자 막 18종을 30–80 ℃, 상대습도 30–95 %에서 함수율과 두께 팽윤을 측정했다.",
    keywords: ["membrane", "water-uptake", "swelling"],
    provenance: "항온항습 챔버와 동적 수분 흡착 분석기로 조건당 2회 측정.",
    project: ["수전해용 고분자 막 소재 개발", "NST-2025-0711", "한국연구재단"],
    file: "data/uptake.csv",
    csv: () => table(["membrane_id", "temp_c", "rh_pct", "water_uptake_pct"], 200, (i) => [`PM-${pad((i % 18) + 1, 2)}`, 30 + (i % 6) * 10, 30 + (i % 5) * 16, (12 + ((i * 7) % 30) * 0.9).toFixed(1)]),
    hints: {},
    preview: "FAILED",
    readiness: { "schema.presence": ["WARNING", "_schema.json이 없어 열 형식을 추정했습니다.", {}] },
  },
];

type UserSpec = [id: string, name: string, email: string, org: string, roles: Schemas["OrgRole"][], nrn: string | null];
const PORTAL_USERS: UserSpec[] = [
  [PORTAL_USER.aResearcher2, "강다은", "a.researcher2@inst-a.local", ORG.a, [], "10000011"],
  [PORTAL_USER.bResearcher2, "노승현", "b.researcher2@inst-b.local", ORG.b, [], "10000012"],
  [PORTAL_USER.cResearcher, "윤재석", "c.researcher@inst-c.local", PORTAL_ORG.c, [], "10000013"],
  [PORTAL_USER.cSteward, "임채원", "c.steward@inst-c.local", PORTAL_ORG.c, ["DATA_STEWARD"], "10000014"],
  [PORTAL_USER.dResearcher, "서지호", "d.researcher@inst-d.local", PORTAL_ORG.d, [], "10000015"],
  [PORTAL_USER.dSteward, "백수민", "d.steward@inst-d.local", PORTAL_ORG.d, ["DATA_STEWARD"], "10000016"],
  [PORTAL_USER.dNewcomer, "문가영", "d.newcomer@inst-d.local", PORTAL_ORG.d, [], "10000017"],
];

/** [request id, requester, dataset, project, purpose, days, status, created (days ago), steps [status, days ago, comment?], grant id] */
type RequestSpec = [string, string, string, string, Schemas["Purpose"], number, Schemas["AccessRequestStatus"], number, [Schemas["AccessRequestStatus"], number, string?][], string | null];
const PURPOSE_DETAIL: Record<Schemas["Purpose"], string> = {
  ACADEMIC_RESEARCH: "공동 과제의 학술 분석에 사용합니다. 결과는 논문으로 공개하며 원자료는 재배포하지 않습니다.",
  AI_TRAINING: "물성 예측 모델의 학습·검증 데이터로 사용합니다. 학습된 모델 가중치만 과제 내부에서 공유합니다.",
  COMMERCIAL_RESEARCH: "참여 기업과 공정 개선 시제품을 평가하는 데 사용합니다.",
  EDUCATION: "대학원 강의 실습 자료로 사용합니다.",
  PUBLIC_INTEREST: "공공 정책 보고서의 근거 자료로 사용합니다.",
};

export function enrichSeed(db: MockDb, now: Date): MockDb {
  const t = now.getTime();
  const kstMidnight = Math.floor((t + KST) / DAY) * DAY - KST;
  /** A working-hours time `daysAgo` days back (KST), never in the future. */
  const at = (daysAgo: number, hour = 10, minute = 0) => {
    const ms = kstMidnight - daysAgo * DAY + (hour * 60 + minute) * 60_000;
    // Later today than "now": pull it back to a spread of minutes before now, so today's rows keep their order.
    return new Date(ms < t - 60_000 ? ms : t - (2 + ((hour * 7 + minute) % 170)) * 60_000).toISOString();
  };
  const iso = (ms: number) => new Date(ms).toISOString();
  const rand = prng(20261002);
  const orgName = (id: string) => db.organizations.find((o) => o.organization_id === id)?.name ?? "";

  // --- Organizations and people -------------------------------------------------------------------------------
  db.organizations.push(
    { organization_id: PORTAL_ORG.c, code: "inst-c", name: "한국기계연구원", type: "RESEARCH_INSTITUTE", ror_id: null, homepage_url: null, member_count: 2, dataset_count: 2, created_at: at(400) },
    { organization_id: PORTAL_ORG.d, code: "inst-d", name: "한국화학연구원", type: "RESEARCH_INSTITUTE", ror_id: null, homepage_url: null, member_count: 2, dataset_count: 2, created_at: at(400) },
  );
  const users: MockUser[] = PORTAL_USERS.map(([user_id, display_name, email, organization_id, org_roles, national_researcher_number]) => ({
    user_id, display_name, email, organization_id, org_roles, platform_roles: [], status: "ACTIVE", membership_status: "ACTIVE", national_researcher_number, history: [], updated_at: at(90),
  }));
  db.users.push(...users);
  for (const o of db.organizations) {
    o.member_count = db.users.filter((u) => u.organization_id === o.organization_id && u.membership_status === "ACTIVE").length;
  }
  const user = (id: string) => db.users.find((u) => u.user_id === id)!;
  const STEWARD: Record<string, string> = { [ORG.a]: USER.aSteward, [ORG.b]: USER.bSteward, [PORTAL_ORG.c]: PORTAL_USER.cSteward, [PORTAL_ORG.d]: PORTAL_USER.dSteward };
  const PI: Record<string, string> = { [ORG.a]: PORTAL_USER.aResearcher2, [ORG.b]: USER.bResearcher, [PORTAL_ORG.c]: PORTAL_USER.cResearcher, [PORTAL_ORG.d]: PORTAL_USER.dResearcher };

  // --- Base records move into the past (ids unchanged) -----------------------------------------------------------
  const BASE_TIMES: Record<string, [created: number, published: number | null]> = {
    [DATASET.battery]: [130, 6],
    [DATASET.openMaterials]: [40, 21],
    [DATASET.qcLogs]: [35, 12],
    [DATASET.sensors]: [50, 17],
    [DATASET.electrolyte]: [4, null],
  };
  const baseVersion: Record<string, string> = { [DATASET.battery]: VERSION.battery, [DATASET.openMaterials]: VERSION.openMaterials, [DATASET.qcLogs]: VERSION.qcLogs, [DATASET.sensors]: VERSION.sensors, [DATASET.electrolyte]: VERSION.electrolyte };
  for (const ds of db.datasets) {
    const times = BASE_TIMES[ds.dataset_id];
    if (!times) continue;
    const [created, published] = times;
    ds.created_at = at(created, 9, 40);
    ds.updated_at = at(published ?? created, 14, 5);
    const v = db.versions.find((x) => x.dataset_version_id === baseVersion[ds.dataset_id]);
    if (v) {
      v.created_at = at((published ?? created) + 1, 16, 20);
      if (v.status === "PUBLISHED" && published !== null) v.published_at = at(published, 14, 5);
    }
  }
  for (const val of db.validations) {
    const v = db.versions.find((x) => x.dataset_version_id === val.dataset_version_id);
    if (!v?.published_at) continue;
    const done = Date.parse(v.published_at) + 40_000;
    Object.assign(val, { created_at: iso(done - 8_000), started_at: iso(done - 6_000), completed_at: iso(done) });
  }
  const seedProject = db.projects.find((p) => p.project_id === PROJECT.seed)!;
  seedProject.created_at = at(45, 11, 10);
  seedProject.updated_at = at(14, 15, 0);
  seedProject.description = "한국에너지기술연구원과 한국재료연구원이 함께 차세대 이차전지 소재의 열화 거동을 분석하는 공동연구.";
  for (const m of db.projectMembers) if (m.project_id === PROJECT.seed) m.joined_at = at(45, 11, 15);
  const seedRequest = db.requests.find((r) => r.access_request_id === REQUEST.seedApproved)!;
  seedRequest.created_at = at(28, 10, 20);
  seedRequest.updated_at = at(27, 15, 40);
  seedRequest.history = [
    { status: "SUBMITTED", at: at(28, 10, 20), by_user_id: USER.aResearcher, comment: null },
    { status: "APPROVED", at: at(27, 15, 40), by_user_id: USER.bSteward, comment: null },
  ];
  const seedGrant = db.grants.find((g) => g.access_grant_id === GRANT.seed)!;
  seedGrant.valid_from = at(27, 15, 40);
  // Base audit rows: same events, dated by what they describe.
  const baseWhen = (e: Schemas["AuditEvent"]): string => {
    const id = e.resource.id;
    switch (e.action) {
      case "PROJECT_CREATED":
        return at(45, 11, 10);
      case "PROJECT_MEMBER_ADDED":
        return at(45, 11, 15);
      case "DATASET_CREATED":
        return db.datasets.find((d) => d.dataset_id === id)?.created_at ?? e.occurred_at;
      case "DATASET_VERSION_PUBLISHED":
        return db.versions.find((v) => v.dataset_version_id === id)?.published_at ?? e.occurred_at;
      case "READINESS_VALIDATION_COMPLETED":
        return db.validations.find((v) => v.validation_id === id)?.completed_at ?? e.occurred_at;
      case "ACCESS_REQUESTED":
        return seedRequest.created_at;
      case "ACCESS_APPROVED":
        return seedRequest.updated_at;
      default:
        return e.occurred_at;
    }
  };
  for (const e of db.audit) e.occurred_at = baseWhen(e);

  // --- Datasets, versions, files, previews, readiness ------------------------------------------------------------
  const encoder = new TextEncoder();
  const validation = (versionId: string, profileId: string, completedMs: number, overrides: DatasetSpec["readiness"]): StoredValidation => {
    const outcome = buildResult(profileId, overrides);
    return {
      validation_id: sid(`b${versionId.slice(-3)}${profileId === "GENERIC_BASIC" ? "1" : "2"}`),
      dataset_version_id: versionId,
      profile_id: profileId,
      profile_version: "1.0.0",
      run_status: "COMPLETED",
      overall_status: outcome.overall_status,
      summary: outcome.summary,
      checks: outcome.checks,
      validator_version: "mock-1.0.0",
      input_fingerprint: hex(versionId.length * 7 + profileId.length),
      error: null,
      triggered_by: "AUTO_ON_PUBLISH",
      created_at: iso(completedMs - 8_000),
      started_at: iso(completedMs - 6_000),
      completed_at: iso(completedMs),
      polls: 0,
      outcome,
    };
  };
  SPECS.forEach((s, i) => {
    const owner = s.owner;
    const dataset: StoredDataset = {
      dataset_id: s.id,
      owner_organization_id: owner,
      owner_organization_name: orgName(owner),
      title: s.title,
      description: s.description,
      keywords: s.keywords,
      domain: s.subjects[0]!.toLowerCase(),
      license: "CC-BY-4.0",
      usage_policy: s.level === "PUBLIC" ? "출처를 표기하면 자유롭게 이용할 수 있다." : "승인된 목적과 기간 안에서만 사용한다. 재배포 금지.",
      contact_email: `steward@${owner === ORG.a ? "inst-a" : owner === ORG.b ? "inst-b" : owner === PORTAL_ORG.c ? "inst-c" : "inst-d"}.example`,
      provenance: s.provenance,
      ...emptyResearch(),
      subtitle: s.subtitle,
      principal_investigator_id: PI[owner]!,
      principal_investigator_org_id: owner,
      data_steward_contact_id: STEWARD[owner]!,
      data_steward_contact_org_id: owner,
      subject_codes: s.subjects,
      method_codes: s.methods,
      material_codes: s.materials,
      collecting_organization_id: owner,
      project_title: s.project[0],
      project_code: s.project[1],
      funding_agency: s.project[2],
      update_frequency: s.frequency,
      access_level: s.level,
      policy: { dataset_id: s.id, owner_organization_id: owner, access_level: s.level, allowed_purposes: s.purposes, approval_required: s.level === "CONTROLLED" || s.level === "SENSITIVE", max_grant_days: s.maxDays },
      status: "ACTIVE",
      created_by: STEWARD[owner]!,
      created_at: at(s.createdDaysAgo, 9, 30 + i),
      updated_at: at(s.publishedDaysAgo, 15, 10 + i * 3),
    };
    db.datasets.push(dataset);

    const body = s.csv();
    const readme = `# ${s.title}\n\n${s.subtitle}\n`;
    const file = (k: number, path: string, text: string, media_type: string): Schemas["DatasetFile"] => ({
      file_id: sid(`a${i + 1}${k}`),
      path,
      size_bytes: encoder.encode(text).length,
      sha256: hex(encoder.encode(text).length * 31 + path.length * 7 + i),
      media_type,
      status: "VERIFIED",
    });
    const files = [file(1, "README.md", readme, "text/markdown"), file(2, s.file, body, "text/csv")];
    const publishedAt = at(s.publishedDaysAgo, 15, 10 + i * 3);
    const version: StoredVersion = {
      dataset_version_id: s.version,
      dataset_id: s.id,
      version_label: s.label,
      status: "PUBLISHED",
      published_at: publishedAt,
      change_note: s.label === "v1" ? "최초 공개" : "측정 기간 연장, 결측 구간 표시 정리",
      files,
      file_count: files.length,
      total_bytes: files.reduce((n, f) => n + f.size_bytes, 0),
      manifest_sha256: hex(files.reduce((n, f) => n + f.size_bytes, i + 11)),
      created_at: at(s.publishedDaysAgo + 1, 17, 0),
    };
    db.versions.push(version);
    const dataFile = files[1]!;
    if (s.preview === "READY") {
      const { columns, preview, rowsSampled, truncated, columnsTruncated } = profileCsv(body, s.file, s.hints);
      db.previews[dataFile.file_id] = { status: "READY", column_profile: { format: "csv", rows_sampled: rowsSampled, truncated, columns_truncated: columnsTruncated, columns }, preview, generated_at: publishedAt };
    } else if (s.preview === "PENDING") {
      db.previews[dataFile.file_id] = { status: "PENDING" };
    } else {
      db.previews[dataFile.file_id] = { status: "FAILED", failure_code: "UNPARSEABLE", generated_at: publishedAt };
    }
    const done = Date.parse(publishedAt) + 40_000;
    db.validations.push(validation(s.version, "TABULAR_ML_BASIC", done, s.readiness), validation(s.version, "GENERIC_BASIC", done + 2_000, s.readiness));
    db.contributors.push({ dataset_id: s.id, user_id: PI[owner]!, role: "CO_INVESTIGATOR", affiliation_organization_id: owner, position: 0 }, { dataset_id: s.id, user_id: STEWARD[owner]!, role: "DATA_CURATOR", affiliation_organization_id: owner, position: 1 });
  });
  for (const o of db.organizations) o.dataset_count = db.datasets.filter((d) => d.owner_organization_id === o.organization_id).length;

  // --- Projects ----------------------------------------------------------------------------------------------------
  const project = (id: string, name: string, lead: string, partners: string[], createdDaysAgo: number, description: string, keywords: string[]) => {
    db.projects.push({
      project_id: id,
      name,
      status: "ACTIVE",
      visibility: "PRIVATE",
      lead_organization_id: lead,
      updated_at: at(Math.max(1, createdDaysAgo - 20), 16, 0),
      description,
      keywords,
      start_date: at(createdDaysAgo).slice(0, 10),
      end_date: null,
      organizations: [{ organization_id: lead, name: orgName(lead), role: "LEAD" }, ...partners.map((o) => ({ organization_id: o, name: orgName(o), role: "PARTNER" as const }))],
      created_by: PI[lead]!,
      created_at: at(createdDaysAgo, 10, 0),
      archived_at: null,
    });
  };
  project(PORTAL_PROJECT.materialsAi, "AI 기반 소재 물성 예측 플랫폼", ORG.b, [ORG.a, PORTAL_ORG.d], 70, "기관별 소재 실험·계산 데이터를 모아 물성 예측 모델을 함께 학습하고 검증한다.", ["materials-informatics", "AI"]);
  project(PORTAL_PROJECT.hydrogen, "수소 생산·저장 소재 공동연구", ORG.a, [ORG.b], 30, "수전해 전극과 저장 합금 후보를 공동으로 평가한다.", ["hydrogen", "electrolysis"]);
  project(PORTAL_PROJECT.maintenance, "제조 설비 예지보전 데이터 연계", PORTAL_ORG.c, [ORG.b], 26, "가공·소결 설비 센서 데이터를 연계해 고장 전조를 탐지한다.", ["predictive-maintenance", "sensor"]);
  const members: [string, string, Schemas["ProjectRole"], number][] = [
    [PORTAL_PROJECT.materialsAi, USER.bResearcher, "PROJECT_OWNER", 70],
    [PORTAL_PROJECT.materialsAi, USER.aResearcher, "RESEARCHER", 68],
    [PORTAL_PROJECT.materialsAi, PORTAL_USER.dResearcher, "RESEARCHER", 66],
    [PORTAL_PROJECT.materialsAi, PORTAL_USER.bResearcher2, "RESEARCHER", 20],
    [PORTAL_PROJECT.hydrogen, PORTAL_USER.aResearcher2, "PROJECT_OWNER", 30],
    [PORTAL_PROJECT.hydrogen, USER.aResearcher, "PROJECT_ADMIN", 30],
    [PORTAL_PROJECT.hydrogen, USER.bResearcher, "RESEARCHER", 29],
    [PORTAL_PROJECT.maintenance, PORTAL_USER.cResearcher, "PROJECT_OWNER", 26],
    [PORTAL_PROJECT.maintenance, PORTAL_USER.cSteward, "RESEARCHER", 26],
    [PORTAL_PROJECT.maintenance, PORTAL_USER.bResearcher2, "VIEWER", 18],
  ];
  for (const [project_id, user_id, role, days] of members) {
    const u = user(user_id);
    db.projectMembers.push({ project_id, user_id, display_name: u.display_name, organization_id: u.organization_id, organization_name: orgName(u.organization_id), role, joined_at: at(days, 11, 0), added_by: db.projects.find((p) => p.project_id === project_id)!.created_by });
  }
  const projectName = (id: string) => db.projects.find((p) => p.project_id === id)!.name;

  // --- Access requests and grants ----------------------------------------------------------------------------------
  const R = (n: number) => sid(`94${pad(n, 2)}`);
  const G = (n: number) => sid(`950${n}`);
  const requests: RequestSpec[] = [
    [R(1), PORTAL_USER.cResearcher, PORTAL_DATASET.semLabels, PORTAL_PROJECT.maintenance, "AI_TRAINING", 90, "SUBMITTED", 3, [], null],
    [R(2), PORTAL_USER.aResearcher2, DATASET.battery, PORTAL_PROJECT.hydrogen, "ACADEMIC_RESEARCH", 60, "UNDER_REVIEW", 6, [["UNDER_REVIEW", 5]], null],
    [R(3), PORTAL_USER.dResearcher, DATASET.battery, PORTAL_PROJECT.materialsAi, "AI_TRAINING", 120, "SUBMITTED", 1, [], null],
    [R(4), PORTAL_USER.cResearcher, DATASET.battery, PORTAL_PROJECT.maintenance, "ACADEMIC_RESEARCH", 90, "APPROVED", 11, [["UNDER_REVIEW", 10], ["APPROVED", 9]], G(1)],
    [R(5), PORTAL_USER.cSteward, PORTAL_DATASET.semLabels, PORTAL_PROJECT.maintenance, "COMMERCIAL_RESEARCH", 60, "REJECTED", 16, [["REJECTED", 15, "데이터 정책상 상업적 연구 목적은 허용하지 않습니다."]], null],
    [R(6), USER.aResearcher, PORTAL_DATASET.semLabels, PORTAL_PROJECT.materialsAi, "AI_TRAINING", 90, "CHANGE_REQUESTED", 4, [["UNDER_REVIEW", 3], ["CHANGE_REQUESTED", 2, "학습 범위와 결과물 보관 기간을 구체적으로 적어 주세요."]], null],
    [R(7), USER.bResearcher, DATASET.sensors, PROJECT.seed, "ACADEMIC_RESEARCH", 30, "SUBMITTED", 2, [], null],
    [R(8), USER.bResearcher, PORTAL_DATASET.fuelCell, PROJECT.seed, "ACADEMIC_RESEARCH", 30, "APPROVED", 16, [["APPROVED", 14]], G(2)],
    [R(9), PORTAL_USER.bResearcher2, PORTAL_DATASET.fuelCell, PORTAL_PROJECT.materialsAi, "AI_TRAINING", 60, "UNDER_REVIEW", 5, [["UNDER_REVIEW", 4]], null],
    [R(10), USER.aResearcher, DATASET.battery, PROJECT.seed, "ACADEMIC_RESEARCH", 90, "SUBMITTED", 0, [], null],
    [R(11), USER.aResearcher, PORTAL_DATASET.spindle, PORTAL_PROJECT.hydrogen, "ACADEMIC_RESEARCH", 30, "APPROVED", 25, [["UNDER_REVIEW", 24], ["APPROVED", 23]], G(3)],
    [R(12), PORTAL_USER.dResearcher, PORTAL_DATASET.semLabels, PORTAL_PROJECT.materialsAi, "AI_TRAINING", 60, "APPROVED", 57, [["APPROVED", 55]], G(4)],
    [R(13), USER.aResearcher, PORTAL_DATASET.membrane, PORTAL_PROJECT.hydrogen, "ACADEMIC_RESEARCH", 90, "APPROVED", 22, [["APPROVED", 20]], G(5)],
  ];
  const ownerOf = (datasetId: string) => db.datasets.find((d) => d.dataset_id === datasetId)!.owner_organization_id;
  const titleOf = (datasetId: string) => db.datasets.find((d) => d.dataset_id === datasetId)!.title;
  const auditRows: Schemas["AuditEvent"][] = [];
  const actorOf = (id: string | null): Schemas["AuditEvent"]["actor"] => {
    const u = id ? user(id) : undefined;
    return u ? { type: "USER", user_id: u.user_id, display_name: u.display_name, organization_id: u.organization_id } : { type: "SYSTEM", user_id: null, display_name: null, organization_id: null };
  };
  const audit = (occurred_at: string, action: Schemas["AuditAction"], by: string | null, type: Schemas["ResourceType"], id: string, owner: string | null, extra: Partial<Schemas["AuditEvent"]> = {}) => {
    if (Date.parse(occurred_at) > t) return;
    auditRows.push({
      audit_event_id: sid(`c${pad(auditRows.length, 5)}`),
      occurred_at,
      action,
      result: "SUCCESS",
      reason: null,
      actor: actorOf(by),
      resource: { type, id, owner_organization_id: owner },
      project_id: null,
      policy_version: action === "ACCESS_APPROVED" ? "data_access@1.0.0" : null,
      source_event_id: sid(`d${pad(auditRows.length, 5)}`),
      source_event_type: "seed.v1",
      trace_id: hex(auditRows.length + 977).slice(-32),
      details: {},
      ...extra,
    });
  };
  const AUDIT_FOR: Partial<Record<Schemas["AccessRequestStatus"], Schemas["AuditAction"]>> = {
    UNDER_REVIEW: "ACCESS_REVIEW_STARTED",
    APPROVED: "ACCESS_APPROVED",
    REJECTED: "ACCESS_REJECTED",
    CHANGE_REQUESTED: "ACCESS_CHANGES_REQUESTED",
    WITHDRAWN: "ACCESS_WITHDRAWN",
  };
  requests.forEach(([id, requester, datasetId, projectId, purpose, days, status, createdDaysAgo, steps, grantId], n) => {
    const owner = ownerOf(datasetId);
    const steward = STEWARD[owner]!;
    const created = at(createdDaysAgo, 9 + (n % 7), (n * 17) % 60);
    const history: NonNullable<Schemas["AccessRequest"]["history"]> = [{ status: "SUBMITTED", at: created, by_user_id: requester, comment: null }];
    for (const [s, d, comment] of steps) history.push({ status: s, at: at(d, 13 + (n % 4), (n * 23) % 60), by_user_id: steward, comment: comment ?? null });
    const requesterUser = user(requester);
    db.requests.push({
      access_request_id: id,
      dataset_id: datasetId,
      dataset_title: titleOf(datasetId),
      project_id: projectId,
      project_name: projectName(projectId),
      requester_user_id: requester,
      requester_display_name: requesterUser.display_name,
      requester_organization_id: requesterUser.organization_id,
      owner_organization_id: owner,
      purpose,
      purpose_detail: PURPOSE_DETAIL[purpose],
      operations: ["READ"],
      requested_days: days,
      status,
      history,
      access_grant_id: grantId,
      created_at: created,
      updated_at: history.at(-1)!.at,
    });
    audit(created, "ACCESS_REQUESTED", requester, "ACCESS_REQUEST", id, owner, { project_id: projectId });
    for (const h of history.slice(1)) {
      const action = AUDIT_FOR[h.status];
      if (action) audit(h.at, action, steward, action === "ACCESS_APPROVED" ? "ACCESS_GRANT" : "ACCESS_REQUEST", action === "ACCESS_APPROVED" && grantId ? grantId : id, owner, { project_id: projectId });
    }
    if (grantId) {
      const from = history.at(-1)!.at;
      db.grants.push({
        access_grant_id: grantId,
        access_request_id: id,
        subject_type: "USER",
        subject_user_id: requester,
        project_id: projectId,
        dataset_id: datasetId,
        dataset_title: titleOf(datasetId),
        subject_display_name: requesterUser.display_name,
        project_name: projectName(projectId),
        purpose,
        operations: ["READ"],
        valid_from: from,
        expires_at: iso(Date.parse(from) + days * DAY),
        granted_by: steward,
        policy_version: "data_access@1.0.0",
        status: "ACTIVE",
        revoked_at: null,
        revoked_by: null,
        revocation_reason: null,
      });
    }
  });

  // --- Audit: dataset lifecycle, projects ----------------------------------------------------------------------
  for (const s of SPECS) {
    const ds = db.datasets.find((d) => d.dataset_id === s.id)!;
    audit(ds.created_at, "DATASET_CREATED", STEWARD[s.owner]!, "DATASET", s.id, s.owner);
    const v = db.versions.find((x) => x.dataset_version_id === s.version)!;
    audit(v.published_at!, "DATASET_VERSION_PUBLISHED", STEWARD[s.owner]!, "DATASET_VERSION", s.version, s.owner);
    for (const val of db.validations.filter((x) => x.dataset_version_id === s.version)) audit(val.completed_at!, "READINESS_VALIDATION_COMPLETED", null, "READINESS_VALIDATION", val.validation_id, s.owner);
  }
  // Metadata touch-ups by stewards between publishes.
  const touch: [string, number, number][] = [
    [DATASET.battery, 20, 11], [DATASET.qcLogs, 13, 16], [PORTAL_DATASET.semLabels, 9, 10], [DATASET.openMaterials, 2, 14],
    [PORTAL_DATASET.fuelCell, 7, 15], [PORTAL_DATASET.solar, 26, 10], [PORTAL_DATASET.dft, 16, 11], [PORTAL_DATASET.spindle, 4, 17],
  ];
  for (const [id, d, h] of touch) audit(at(d, h, 25), "DATASET_UPDATED", STEWARD[ownerOf(id)]!, "DATASET", id, ownerOf(id));
  for (const p of db.projects.filter((x) => x.project_id !== PROJECT.seed)) audit(p.created_at, "PROJECT_CREATED", p.created_by ?? null, "PROJECT", p.project_id, p.lead_organization_id, { project_id: p.project_id });
  for (const [project_id, user_id, , days] of members.filter(([, , role]) => role !== "PROJECT_OWNER")) {
    const p = db.projects.find((x) => x.project_id === project_id)!;
    audit(at(days, 11, 0), "PROJECT_MEMBER_ADDED", p.created_by ?? null, "PROJECT_MEMBER", user_id, user(user_id).organization_id, { project_id });
  }

  // --- Audit: downloads with a weekday rhythm ----------------------------------------------------------------------
  type Source = { dataset: string; who: string[]; from?: number };
  const grantHolders = (datasetId: string) => db.grants.filter((g) => g.dataset_id === datasetId && g.status === "ACTIVE");
  const ownMembers = (org: string) => db.users.filter((u) => u.organization_id === org && u.membership_status === "ACTIVE" && !u.platform_roles.length && u.user_id !== PORTAL_USER.dNewcomer).map((u) => u.user_id);
  const researchers = db.users.filter((u) => u.membership_status === "ACTIVE" && !u.platform_roles.length && u.user_id !== PORTAL_USER.dNewcomer && !u.org_roles.includes("ORG_ADMIN")).map((u) => u.user_id);
  const published = db.datasets
    .map((d) => ({ d, v: db.versions.filter((v) => v.dataset_id === d.dataset_id && v.status === "PUBLISHED").sort((a, b) => String(b.published_at).localeCompare(String(a.published_at)))[0] }))
    .filter((x): x is { d: StoredDataset; v: StoredVersion } => !!x.v);
  const sources: Source[] = published.map(({ d }) => ({
    dataset: d.dataset_id,
    who: d.access_level === "PUBLIC" ? researchers : [...ownMembers(d.owner_organization_id), ...grantHolders(d.dataset_id).map((g) => g.subject_user_id)],
  }));
  // Heavier pull on the datasets people are actually working with.
  const weight: Record<string, number> = { [DATASET.battery]: 5, [DATASET.openMaterials]: 3, [PORTAL_DATASET.fuelCell]: 2, [PORTAL_DATASET.semLabels]: 2, [PORTAL_DATASET.weld]: 2, [PORTAL_DATASET.dft]: 2 };
  const pool = sources.flatMap((s) => Array.from({ length: weight[s.dataset] ?? 1 }, () => s));
  for (let d = 29; d >= 0; d--) {
    const weekday = new Date(kstMidnight - d * DAY + KST).getUTCDay();
    const weekend = weekday === 0 || weekday === 6;
    const n = weekend ? Math.floor(rand() * 2) : 4 + Math.floor(rand() * 6) + (d < 10 ? 2 : 0);
    for (let k = 0; k < n; k++) {
      const src = pool[Math.floor(rand() * pool.length)]!;
      const { d: ds } = published.find((x) => x.d.dataset_id === src.dataset)!;
      const when = at(d, 9 + Math.floor(rand() * 9), Math.floor(rand() * 60));
      // The version that was current on that day (battery has v1.0 / v1.1 before v2.0).
      const v = db.versions
        .filter((x) => x.dataset_id === ds.dataset_id && x.status === "PUBLISHED" && Date.parse(x.published_at!) <= Date.parse(when))
        .sort((a, b) => String(b.published_at).localeCompare(String(a.published_at)))[0];
      if (!v) continue;
      const who = src.who.filter((id) => {
        if (ds.access_level === "PUBLIC" || user(id).organization_id === ds.owner_organization_id) return true;
        const g = grantHolders(ds.dataset_id).find((x) => x.subject_user_id === id);
        return !!g && Date.parse(g.valid_from) <= Date.parse(when);
      });
      if (!who.length) continue;
      const by = who[Math.floor(rand() * who.length)]!;
      const f = v.files.find((x) => x.path.startsWith("data/")) ?? v.files[0]!;
      audit(when, "FILE_DOWNLOADED", by, "DATASET_FILE", f.file_id, ds.owner_organization_id, { details: { dataset_id: ds.dataset_id, dataset_version_id: v.dataset_version_id, path: f.path } });
    }
  }
  // Two refused downloads (no grant yet): visible to the owner institute.
  for (const [who, datasetId, d] of [[PORTAL_USER.dResearcher, DATASET.battery, 1], [PORTAL_USER.cResearcher, PORTAL_DATASET.semLabels, 3]] as const) {
    const v = published.find((x) => x.d.dataset_id === datasetId)!.v;
    const f = v.files.find((x) => x.path.startsWith("data/")) ?? v.files[0]!;
    audit(at(d, 16, 12), "DOWNLOAD_DENIED", who, "DATASET_FILE", f.file_id, ownerOf(datasetId), { result: "DENIED", reason: "ACCESS_GRANT_REQUIRED", details: { dataset_id: datasetId } });
  }
  db.audit.push(...auditRows);
  db.audit.sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));
  return db;
}
