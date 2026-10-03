import type { Schemas } from "@/shared/api/types";
import { profileCsv, type Hint } from "./previews";
import * as tables from "./seed-tables";
import { buildResult } from "./readiness-results";
import { SEED_FILES } from "./seed-files";
import { VOCABULARY } from "./vocabulary";
import type { MockDb, MockUser, StoredDataset, StoredValidation, StoredVersion } from "./types";

/**
 * Mirrors the real seed (NAIS_PRD/10_SEED_DATA.md): ids and titles come from
 * apps/api/modules/{identity,project,catalog}/seed_data.py and infra/keycloak/seed_ids.json.
 * Everything is stamped at "seed time" (now), like the backend seed.
 */
export const sid = (suffix: string) => `00000000-0000-7000-8000-${suffix.padStart(12, "0")}`;
export const hex = (n: number) => n.toString(16).padStart(64, "0");

export const ORG = { nais: sid("0001"), a: sid("000a"), b: sid("000b") } as const;
export const USER = {
  admin: sid("0101"),
  aAdmin: sid("0a01"),
  aResearcher: sid("0a02"),
  aSteward: sid("0a03"),
  bAdmin: sid("0b01"),
  bResearcher: sid("0b02"),
  bSteward: sid("0b03"),
  bDisabled: sid("0b04"),
} as const;
export const PROJECT = { seed: sid("1001") } as const;
export const DATASET = { battery: sid("2001"), openMaterials: sid("2002"), qcLogs: sid("2003"), sensors: sid("2004"), electrolyte: sid("2005") } as const;
export const VERSION = { batteryV10: sid("2111"), batteryV11: sid("2112"), batteryDraft: sid("2113"), battery: sid("2101"), openMaterials: sid("2102"), qcLogs: sid("2103"), sensors: sid("2104"), electrolyte: sid("2105") } as const;
export const REQUEST = { seedApproved: sid("3001") } as const;
export const GRANT = { seed: sid("4001") } as const;

const users: Omit<MockUser, "updated_at">[] = [
  { user_id: USER.admin, display_name: "송태호", email: "admin@nais.local", organization_id: ORG.nais, org_roles: ["ORG_ADMIN"], platform_roles: ["PLATFORM_ADMIN"], status: "ACTIVE", membership_status: "ACTIVE", national_researcher_number: null, history: [] },
  { user_id: USER.aAdmin, display_name: "박지훈", email: "a.admin@inst-a.local", organization_id: ORG.a, org_roles: ["ORG_ADMIN"], platform_roles: [], status: "ACTIVE", membership_status: "ACTIVE", national_researcher_number: null, history: [] },
  { user_id: USER.aResearcher, display_name: "김민준", email: "a.researcher@inst-a.local", organization_id: ORG.a, org_roles: [], platform_roles: [], status: "ACTIVE", membership_status: "ACTIVE", national_researcher_number: "10000001", history: [] },
  { user_id: USER.aSteward, display_name: "이서연", email: "a.steward@inst-a.local", organization_id: ORG.a, org_roles: ["DATA_STEWARD"], platform_roles: [], status: "ACTIVE", membership_status: "ACTIVE", national_researcher_number: "10000003", history: [] },
  { user_id: USER.bAdmin, display_name: "한유나", email: "b.admin@inst-b.local", organization_id: ORG.b, org_roles: ["ORG_ADMIN"], platform_roles: [], status: "ACTIVE", membership_status: "ACTIVE", national_researcher_number: null, history: [] },
  { user_id: USER.bResearcher, display_name: "최유진", email: "b.researcher@inst-b.local", organization_id: ORG.b, org_roles: [], platform_roles: [], status: "ACTIVE", membership_status: "ACTIVE", national_researcher_number: "10000002", history: [] },
  { user_id: USER.bSteward, display_name: "정현우", email: "b.steward@inst-b.local", organization_id: ORG.b, org_roles: ["DATA_STEWARD"], platform_roles: [], status: "ACTIVE", membership_status: "ACTIVE", national_researcher_number: "10000004", history: [] },
  { user_id: USER.bDisabled, display_name: "조하은", email: "b.disabled@inst-b.local", organization_id: ORG.b, org_roles: [], platform_roles: [], status: "ACTIVE", membership_status: "DISABLED", national_researcher_number: null, history: [] },
];


const STEWARD = { [ORG.a]: USER.aSteward, [ORG.b]: USER.bSteward } as Record<string, string>;
const ORG_NAME = { [ORG.nais]: "국가과학AI연구센터", [ORG.a]: "한국에너지기술연구원", [ORG.b]: "한국재료연구원" } as Record<string, string>;

/** Mock login choices (M10 §13: "seed 사용자 선택 드롭다운"): name and institute, as an SSO account picker shows them. */
export const SEED_USERS = users.map((u) => ({ id: u.user_id, label: u.display_name, email: u.email, organization: ORG_NAME[u.organization_id] ?? "" }));

type Fixture = "clean_tabular" | "missing_metadata" | "invalid_units" | "missing_provenance" | null;
type Meta = { description: string; keywords: string[]; domain: string | null; license: string; usage_policy: string | null; contact_email: string | null; provenance: string | null };

/** Descriptive metadata per seed dataset (distinct, matching each title); per-fixture degradations are applied on top by metadataFor(). */
const META: Record<string, Meta> = {
  [DATASET.battery]: {
    description: [
      "리튬이온 18650 셀 12개를 상온(25 ℃)에서 1C 정전류-정전압으로 충방전하며 사이클별 용량, 평균 전압, 셀 표면 온도를 기록한 사이클 수명 시험 데이터셋이다.",
      "NCM811/흑연 계열 8개 셀과 NCM811/실리콘-탄소 계열 4개 셀이 포함되며, 용량 유지율 80 % 도달 시점까지 열화 경향을 확인할 수 있다.",
      "",
      "- `data/measurements.csv`: 사이클별 `capacity_ah`, `voltage_v`, `temp_c`",
      "- `data/test_cells.csv`: 셀별 화학계와 정격 용량 (v1.1 이후)",
      "- `_codebook.csv`, `_schema.json`: 컬럼 정의와 단위 (v2.0)",
    ].join("\n"),
    keywords: ["lithium-ion", "cycle-life", "capacity-fade", "NCM811", "battery"],
    domain: "energy",
    license: "CC-BY-4.0",
    usage_policy: "학술 연구 및 AI 학습 목적에 한해 사용한다. 재배포 금지. 결과 공개 시 출처를 표기한다.",
    contact_email: "steward@inst-b.example",
    provenance: "한국재료연구원 이차전지 실험실의 충방전 시험기(모델 BT-5000)와 항온 챔버에서 2026년 1월부터 6월까지 사이클마다 자동 수집한 측정값. 사이클 1~200은 v1.0, 201~500은 v1.1, 501~1000은 v2.0에서 추가되었다.",
  },
  [DATASET.openMaterials]: {
    description: [
      "세라믹과 초내열 합금 4종(Al2O3, ZrO2, Inconel 718, Ti-6Al-4V) 시편의 밀도, 비커스 경도, XRD 격자상수를 정리한 공개 재료 물성 표이다.",
      "2024년 1월부터 2025년 12월까지 공동 장비실에서 측정한 값을 연 1회 갱신하며, 시편 번호로 원 측정 조건 문서와 연결할 수 있다.",
    ].join("\n\n"),
    keywords: ["materials-properties", "ceramic", "superalloy", "hardness", "XRD"],
    domain: "materials",
    license: "CC-BY-4.0",
    usage_policy: "출처를 표기하면 자유롭게 이용할 수 있다.",
    contact_email: "steward@inst-b.example",
    provenance: "한국재료연구원 공동 장비실의 Vickers 경도계와 분말 XRD(Cu Kα)로 시편당 5회 측정해 평균한 값.",
  },
  [DATASET.qcLogs]: {
    description: [
      "한국재료연구원 시제품 소결 라인 3개의 배치별 공정 온도와 압력, 검사 시각을 기록한 내부 품질관리(QC) 로그이다.",
      "월 단위로 누적되며 내부 공정 개선과 이상 배치 탐지 연구에만 사용한다. 일부 단위 표기가 UCUM이 아니므로 정리가 필요하다.",
    ].join("\n\n"),
    keywords: ["quality-control", "sintering", "process-log", "batch", "internal"],
    domain: "materials",
    license: "CC-BY-4.0",
    usage_policy: "한국재료연구원 내부 연구 목적으로만 사용한다. 외부 공유 금지.",
    contact_email: "steward@inst-b.example",
    provenance: "소결 라인 PLC가 배치 종료 시 기록한 공정값을 월 1회 수집해 정리한 로그.",
  },
  [DATASET.sensors]: {
    description: "시설 센서 측정 데이터",
    keywords: ["facility", "sensor", "HVAC", "humidity", "vibration"],
    domain: "environment",
    license: "CC-BY-4.0",
    usage_policy: "시설 운영 정보이므로 승인된 학술 연구 목적에 한해 사용한다.",
    contact_email: "steward@inst-a.example",
    provenance: "한국에너지기술연구원 시험동 공조 설비(HVAC 1~4호기)에 설치된 상대습도·온도·진동 센서가 15분 간격으로 기록한 스트림.",
  },
  [DATASET.electrolyte]: {
    description: [
      "고체-액체 하이브리드 전해질 후보 조성 24종의 이온전도도와 전기화학 안정창을 스크리닝한 초안 데이터셋이다.",
      "외부 위탁분석기관에서 측정 중이며 결과가 도착하는 대로 비정기적으로 갱신된다. 아직 검증되지 않은 값이 포함될 수 있다.",
    ].join("\n\n"),
    keywords: ["electrolyte", "ionic-conductivity", "screening", "solid-state"],
    domain: "energy",
    license: "CC-BY-4.0",
    usage_policy: "학술 연구 및 AI 학습 목적에 한해 사용한다. 초안 단계이므로 인용하지 않는다.",
    contact_email: "steward@inst-a.example",
    provenance: "한국에너지기술연구원가 합성한 조성 시료를 외부 위탁분석기관 K-Lab이 임피던스 분광과 순환전압전류법으로 측정한 결과.",
  },
};
function metadataFor(datasetId: string, fixture: Fixture) {
  const m: Meta = { ...META[datasetId]! };
  // Degraded on purpose so the seed readiness outcome (09_AI_READY_RULES §5.6) is explainable from the metadata itself.
  if (fixture === "missing_metadata") Object.assign(m, { keywords: [], domain: null, contact_email: null });
  if (fixture === "missing_provenance") m.provenance = null;
  return m;
}

/** Research columns of a brand-new dataset (backend insert_dataset defaults). */
export function emptyResearch() {
  return {
    subtitle: null as string | null,
    principal_investigator_id: null as string | null,
    principal_investigator_org_id: null as string | null,
    data_steward_contact_id: null as string | null,
    data_steward_contact_org_id: null as string | null,
    contact_email_public: false,
    project_title: null as string | null,
    project_code: null as string | null,
    funding_agency: null as string | null,
    subject_codes: [] as string[],
    method_codes: [] as string[],
    material_codes: [] as string[],
    method_detail: null as string | null,
    temporal_start: null as string | null,
    temporal_end: null as string | null,
    collecting_organization_id: null as string | null,
    collecting_organization_name: null as string | null,
    update_frequency: "ONCE" as Schemas["UpdateFrequency"],
    related_publications: [] as Schemas["RelatedPublication"][],
  };
}

/** Mirror of apps/api/modules/catalog/seed_data.py RESEARCH + PEOPLE (PI and steward contact belong to the owner org). */
const PEOPLE = { [ORG.a]: [USER.aResearcher, USER.aSteward], [ORG.b]: [USER.bResearcher, USER.bSteward] } as Record<string, [string, string]>;
const RESEARCH: Record<string, Partial<ReturnType<typeof emptyResearch>>> = {
  [DATASET.battery]: {
    subtitle: "리튬이온 18650 셀 12개의 1,000 사이클 충방전 용량·전압·온도 이력",
    subject_codes: ["ENERGY", "BATTERY"],
    material_codes: ["CATHODE", "ANODE", "ELECTROLYTE"],
    method_codes: ["ELECTROCHEM_CYCLING", "SENSOR_LOGGING"],
    method_detail: "충방전 시험기 BT-5000, 1C CC-CV(2.5–4.2 V), 항온 챔버 25 ℃, 사이클마다 용량·평균 전압·표면 온도 기록",
    temporal_start: "2026-01-12",
    temporal_end: "2026-06-30",
    collecting_organization_id: ORG.b,
    project_title: "차세대 이차전지 수명 예측 연구",
    project_code: "NST-2026-0101",
    funding_agency: "국가과학기술연구회",
    update_frequency: "QUARTERLY",
    contact_email_public: true,
    related_publications: [],
  },
  [DATASET.openMaterials]: {
    subtitle: "세라믹·초내열 합금 4종의 밀도, 경도, 격자상수 (2024–2025)",
    subject_codes: ["MATERIALS"],
    material_codes: ["METAL_ALLOY", "CERAMIC"],
    method_codes: ["XRD"],
    method_detail: "분말 XRD(Cu Kα, 2θ 20–90°)와 Vickers 경도(HV10), 시편당 5회 평균",
    temporal_start: "2024-01-15",
    temporal_end: "2025-12-19",
    // Collected by the other council institute (not the owner).
    collecting_organization_id: ORG.a,
    project_title: "공개 재료 물성 DB 구축",
    project_code: "NST-2024-0207",
    funding_agency: "과학기술정보통신부",
    update_frequency: "YEARLY",
    related_publications: [],
  },
  [DATASET.qcLogs]: {
    subtitle: "소결 라인 3기의 배치별 공정 온도·압력 QC 로그 (월 갱신)",
    subject_codes: ["MATERIALS"],
    material_codes: ["CERAMIC"],
    method_codes: ["SENSOR_LOGGING"],
    method_detail: "소결로 PLC 로그를 배치 종료 시 수집, 월 1회 정리",
    temporal_start: "2025-07-01",
    // Open-ended: the log keeps growing.
    temporal_end: null,
    collecting_organization_id: ORG.b,
    project_title: "소결 공정 이상 탐지 고도화",
    project_code: "NST-2025-0318",
    funding_agency: "산업통상자원부",
    update_frequency: "MONTHLY",
    related_publications: [],
  },
  [DATASET.sensors]: {
    subtitle: "시험동 공조 설비 4기의 습도·온도·진동 센서 스트림",
    subject_codes: ["ENVIRONMENT", "STANDARDS"],
    material_codes: [],
    method_codes: ["SENSOR_LOGGING"],
    method_detail: "상대습도·온도·RMS 진동 센서, 15분 간격 수집",
    temporal_start: "2026-02-01",
    temporal_end: "2026-08-31",
    collecting_organization_id: ORG.a,
    project_title: "연구시설 환경 모니터링 체계 구축",
    project_code: "NST-2026-0415",
    funding_agency: "국가과학기술연구회",
    update_frequency: "MONTHLY",
    related_publications: [],
  },
  [DATASET.electrolyte]: {
    subtitle: "하이브리드 전해질 후보 24종의 이온전도도·안정창 스크리닝 (초안)",
    subject_codes: ["ENERGY", "CHEMISTRY"],
    material_codes: ["ELECTROLYTE", "POLYMER"],
    method_codes: ["ELECTROCHEM_CYCLING"],
    method_detail: "임피던스 분광(1 MHz–0.1 Hz)과 순환전압전류법(0–5 V vs Li/Li+)",
    temporal_start: "2026-03-01",
    temporal_end: "2026-06-30",
    collecting_organization_name: "외부 위탁분석기관 K-Lab",
    project_title: "고체전해질 후보 물질 탐색",
    project_code: "NST-2026-0522",
    funding_agency: "한국연구재단",
    update_frequency: "IRREGULAR",
    related_publications: [],
  },
};

/** Contributors: [dataset, user, role, affiliation org at the time]. Any active member qualifies (not only the owner org). */
const CONTRIBUTORS: [string, string, Schemas["ContributorRole"], string][] = [
  [DATASET.battery, USER.bResearcher, "CO_INVESTIGATOR", ORG.b],
  [DATASET.battery, USER.aResearcher, "DATA_COLLECTOR", ORG.a],
  [DATASET.battery, USER.bSteward, "DATA_CURATOR", ORG.b],
  [DATASET.openMaterials, USER.aResearcher, "DATA_COLLECTOR", ORG.a],
  [DATASET.openMaterials, USER.bSteward, "DATA_CURATOR", ORG.b],
  [DATASET.qcLogs, USER.bResearcher, "DATA_COLLECTOR", ORG.b],
  [DATASET.sensors, USER.aSteward, "DATA_CURATOR", ORG.a],
  [DATASET.electrolyte, USER.bResearcher, "CO_INVESTIGATOR", ORG.b],
];

function policy(dataset_id: string, owner: string, level: Schemas["AccessLevel"], purposes: Schemas["Purpose"][], maxDays: number): Schemas["DatasetPolicyView"] {
  return {
    dataset_id,
    owner_organization_id: owner,
    access_level: level,
    allowed_purposes: purposes,
    approval_required: level === "CONTROLLED" || level === "SENSITIVE",
    max_grant_days: maxDays,
  };
}

export function createSeed(now: Date): MockDb {
  const t = now.getTime();
  const at = (seconds: number) => new Date(t + seconds * 1000).toISOString();
  const later = (days: number) => new Date(t + days * 86_400_000).toISOString();
  const seedTime = at(0);
  const ALL_PURPOSES: Schemas["Purpose"][] = ["ACADEMIC_RESEARCH", "AI_TRAINING", "COMMERCIAL_RESEARCH", "EDUCATION", "PUBLIC_INTEREST"];

  const organizations: Schemas["Organization"][] = [
    { organization_id: ORG.nais, code: "nais", name: "국가과학AI연구센터", type: "PLATFORM_OPERATOR", ror_id: null, homepage_url: null, member_count: 1, dataset_count: 0, created_at: seedTime },
    { organization_id: ORG.a, code: "inst-a", name: "한국에너지기술연구원", type: "RESEARCH_INSTITUTE", ror_id: null, homepage_url: null, member_count: 3, dataset_count: 2, created_at: seedTime },
    { organization_id: ORG.b, code: "inst-b", name: "한국재료연구원", type: "RESEARCH_INSTITUTE", ror_id: null, homepage_url: null, member_count: 4, dataset_count: 3, created_at: seedTime },
  ];

  const seedDatasets: {
    id: string;
    owner: string;
    title: string;
    level: Schemas["AccessLevel"];
    purposes: Schemas["Purpose"][];
    maxDays: number;
    fixture: Fixture;
  }[] = [
    { id: DATASET.battery, owner: ORG.b, title: "리튬이온 배터리 셀 사이클 시험 데이터", level: "CONTROLLED", purposes: ["ACADEMIC_RESEARCH", "AI_TRAINING"], maxDays: 180, fixture: "clean_tabular" },
    { id: DATASET.openMaterials, owner: ORG.b, title: "구조용 세라믹·초내열합금 물성 DB", level: "PUBLIC", purposes: ALL_PURPOSES, maxDays: 365, fixture: "missing_provenance" },
    { id: DATASET.qcLogs, owner: ORG.b, title: "소결 공정 배치별 품질관리 로그", level: "INTERNAL", purposes: ["ACADEMIC_RESEARCH"], maxDays: 90, fixture: "invalid_units" },
    { id: DATASET.sensors, owner: ORG.a, title: "시험동 공조 설비 센서 스트림", level: "SENSITIVE", purposes: ["ACADEMIC_RESEARCH"], maxDays: 30, fixture: "missing_metadata" },
    { id: DATASET.electrolyte, owner: ORG.a, title: "하이브리드 전해질 후보 스크리닝 (초안)", level: "CONTROLLED", purposes: ["AI_TRAINING"], maxDays: 90, fixture: null },
  ];
  const filesKey: Record<string, keyof typeof SEED_FILES> = {
    [DATASET.battery]: "battery",
    [DATASET.openMaterials]: "openMaterials",
    [DATASET.qcLogs]: "qcLogs",
    [DATASET.sensors]: "sensors",
  };
  const versionOf: Record<string, string> = {
    [DATASET.battery]: VERSION.battery,
    [DATASET.openMaterials]: VERSION.openMaterials,
    [DATASET.qcLogs]: VERSION.qcLogs,
    [DATASET.sensors]: VERSION.sensors,
    [DATASET.electrolyte]: VERSION.electrolyte,
  };

  const datasets: StoredDataset[] = seedDatasets.map((d) => ({
    dataset_id: d.id,
    owner_organization_id: d.owner,
    owner_organization_name: ORG_NAME[d.owner],
    title: d.title,
    ...metadataFor(d.id, d.fixture),
    ...emptyResearch(),
    principal_investigator_id: PEOPLE[d.owner]![0],
    principal_investigator_org_id: d.owner,
    data_steward_contact_id: PEOPLE[d.owner]![1],
    data_steward_contact_org_id: d.owner,
    ...RESEARCH[d.id],
    access_level: d.level,
    policy: policy(d.id, d.owner, d.level, d.purposes, d.maxDays),
    status: "ACTIVE",
    created_by: STEWARD[d.owner]!,
    created_at: seedTime,
    updated_at: seedTime,
  }));

  const versions: StoredVersion[] = seedDatasets.map((d) => {
    const seeded = filesKey[d.id] ? SEED_FILES[filesKey[d.id]!]! : undefined;
    const files: Schemas["DatasetFile"][] = (seeded?.files ?? []).map((f) => ({ ...f, status: "VERIFIED" }));
    const published = d.fixture !== null;
    const isBattery = d.id === DATASET.battery;
    return {
      dataset_version_id: versionOf[d.id]!,
      dataset_id: d.id,
      version_label: isBattery ? "v2.0" : "v1",
      status: published ? "PUBLISHED" : "DRAFT",
      published_at: published ? seedTime : null,
      change_note: isBattery ? "사이클 501~1000 추가, 컬럼 정의(_codebook.csv)와 스키마(_schema.json) 정비, 셀 정보 파일 포함" : "Seed data (10_SEED_DATA.md)",
      files,
      file_count: files.length,
      total_bytes: files.reduce((n, f) => n + f.size_bytes, 0),
      manifest_sha256: published ? (seeded?.manifest_sha256 ?? null) : null,
      created_at: seedTime,
      created_by: STEWARD[d.owner]!,
      base_version_id: null,
      source_version_id: null,
      previous_version_id: null,
    };
  });

  // Battery history: v1.0 and v1.1 are older PUBLISHED versions; the DRAFT is only visible to the owner steward (access.can_see_all_versions).
  const encoder = new TextEncoder();
  const batteryFile = (versionId: string, path: string, body: string, media_type: string): Schemas["DatasetFile"] => ({
    file_id: sid(`${versionId.slice(-4)}${hex(path.length + body.length).slice(-4)}${String(path.length).padStart(2, "0")}`).slice(0, 36),
    path,
    size_bytes: encoder.encode(body).length,
    sha256: hex(encoder.encode(body).length * 31 + path.length * 7),
    media_type,
    status: "VERIFIED",
  });
  const README_V10 = "# 리튬이온 배터리 셀 사이클 시험 데이터\n\n18650 셀 사이클 1~200 (v1.0).";
  const README_V11 = "# 리튬이온 배터리 셀 사이클 시험 데이터\n\n18650 셀 사이클 1~500 (v1.1), 셀 정보 추가.";
  const batteryVersion = (id: string, label: string, status: "PUBLISHED" | "DRAFT", daysAgo: number, note: string, files: Schemas["DatasetFile"][]): StoredVersion => ({
    dataset_version_id: id,
    dataset_id: DATASET.battery,
    version_label: label,
    status,
    published_at: status === "PUBLISHED" ? at(-daysAgo * 86_400) : null,
    change_note: note,
    files,
    file_count: files.length,
    total_bytes: files.reduce((n, f) => n + f.size_bytes, 0),
    manifest_sha256: status === "PUBLISHED" ? hex(files.reduce((n, f) => n + f.size_bytes, id.length)) : null,
    created_at: at(-daysAgo * 86_400 - 3600),
    created_by: STEWARD[ORG.b]!,
    base_version_id: null,
    source_version_id: null,
    previous_version_id: null,
  });
  const csvV10 = tables.batteryCycles(200);
  const csvV11 = tables.batteryCycles(500);
  const csvDraft = tables.batteryCycles(1200);
  const cellsCsv = tables.batteryCells();
  const batteryHistory: StoredVersion[] = [
    batteryVersion(VERSION.batteryV10, "v1.0", "PUBLISHED", 120, "최초 공개: 셀 12개의 사이클 1~200 용량·전압·온도", [
      batteryFile(VERSION.batteryV10, "README.md", README_V10, "text/markdown"),
      batteryFile(VERSION.batteryV10, "data/measurements.csv", csvV10, "text/csv"),
    ]),
    batteryVersion(VERSION.batteryV11, "v1.1", "PUBLISHED", 60, "사이클 201~500 추가, 셀별 화학계·정격 용량 파일(test_cells.csv) 추가", [
      batteryFile(VERSION.batteryV11, "README.md", README_V11, "text/markdown"),
      batteryFile(VERSION.batteryV11, "data/test_cells.csv", cellsCsv, "text/csv"),
      batteryFile(VERSION.batteryV11, "data/measurements.csv", csvV11, "text/csv"),
    ]),
    batteryVersion(VERSION.batteryDraft, "v2.1-draft", "DRAFT", 3, "사이클 1001~1200 추가 및 이상 셀(C07) 제외 검토 중", [
      batteryFile(VERSION.batteryDraft, "data/measurements.csv", csvDraft, "text/csv"),
    ]),
  ];
  // v2.0 (VERSION.battery) additionally ships the cell table; its CSV is the 1,000-cycle series.
  const v20 = versions.find((v) => v.dataset_version_id === VERSION.battery)!;
  v20.files.push(batteryFile(VERSION.battery, "data/test_cells.csv", cellsCsv, "text/csv"));
  v20.file_count = v20.files.length;
  v20.total_bytes = v20.files.reduce((n, f) => n + f.size_bytes, 0);
  v20.published_at = seedTime;
  versions.push(...batteryHistory);

  // Lineage (spec §3.3b): v1.0 -> v1.1 -> v2.0 on the published line; the draft branches from v2.0 and inherits its files
  // (same objects, new row ids) except the measurements series it replaces.
  const lineage = (id: string, from: string) => Object.assign(versions.find((v) => v.dataset_version_id === id)!, { base_version_id: from, source_version_id: from, previous_version_id: from });
  lineage(VERSION.batteryV11, VERSION.batteryV10);
  lineage(VERSION.battery, VERSION.batteryV11);
  const draftV = versions.find((v) => v.dataset_version_id === VERSION.batteryDraft)!;
  Object.assign(draftV, { base_version_id: VERSION.battery, source_version_id: VERSION.battery });
  const inheritedRows = v20.files
    .filter((f) => f.path !== "data/measurements.csv")
    .map((f, i) => ({ ...f, file_id: sid(`ab${i + 1}`), inherited_from: f.file_id }));
  draftV.files.push(...inheritedRows);
  draftV.file_count = draftV.files.length;
  // Metadata as it stood at v1.0 / v1.1 (applied over the current metadata until a snapshot is frozen), so the compare
  // screen's metadata layer has real history: a narrower period, fewer keywords, an earlier licence and description.
  const README_DESC = (cycles: string, files: string[]) =>
    [
      `리튬이온 18650 셀 12개를 상온(25 ℃)에서 1C 정전류-정전압으로 충방전하며 사이클별 용량, 평균 전압, 셀 표면 온도를 기록한 사이클 수명 시험 데이터셋이다. ${cycles}`,
      "",
      ...files,
    ].join("\n");
  Object.assign(versions.find((v) => v.dataset_version_id === VERSION.batteryV10)!, {
    metadata_overrides: {
      subtitle: "리튬이온 18650 셀 12개의 200 사이클 충방전 용량·전압·온도 이력",
      description: README_DESC("사이클 1~200까지 수록했다.", ["- `data/measurements.csv`: 사이클별 `capacity_ah`, `voltage_v`, `temp_c`"]),
      keywords: ["lithium-ion", "cycle-life"],
      license: "CC-BY-NC-4.0",
      temporal_end: "2026-02-20",
      update_frequency: "IRREGULAR",
    },
  });
  Object.assign(versions.find((v) => v.dataset_version_id === VERSION.batteryV11)!, {
    metadata_overrides: {
      subtitle: "리튬이온 18650 셀 12개의 500 사이클 충방전 용량·전압·온도 이력",
      description: README_DESC("사이클 1~500까지 수록했고 셀 정보 파일을 더했다.", [
        "- `data/measurements.csv`: 사이클별 `capacity_ah`, `voltage_v`, `temp_c`",
        "- `data/test_cells.csv`: 셀별 화학계와 정격 용량",
      ]),
      keywords: ["lithium-ion", "cycle-life", "capacity-fade"],
      license: "CC-BY-NC-4.0",
      temporal_end: "2026-04-10",
    },
  });
  draftV.total_bytes = draftV.files.reduce((n, f) => n + f.size_bytes, 0);

  // Each tabular file gets a profile/preview built from a topic-specific CSV (not the shared README/codebook files, which start with "_" or are markdown).
  const tableFor = (v: StoredVersion, path: string): { text: string; hints: Record<string, Hint> } | null => {
    if (path === "data/test_cells.csv") return { text: cellsCsv, hints: tables.BATTERY_CELLS_HINTS };
    if (path !== "data/measurements.csv") return null;
    if (v.dataset_id === DATASET.battery) {
      const rows = v.dataset_version_id === VERSION.batteryV10 ? 200 : v.dataset_version_id === VERSION.batteryV11 ? 500 : v.dataset_version_id === VERSION.batteryDraft ? 1200 : 1000;
      return { text: tables.batteryCycles(rows), hints: tables.BATTERY_CYCLES_HINTS };
    }
    if (v.dataset_id === DATASET.openMaterials) return { text: tables.openMaterials(), hints: tables.OPEN_MATERIALS_HINTS };
    if (v.dataset_id === DATASET.qcLogs) return { text: tables.qcLogs(), hints: tables.QC_LOGS_HINTS };
    if (v.dataset_id === DATASET.sensors) return { text: tables.sensors(), hints: tables.SENSORS_HINTS };
    return null;
  };
  const previews: MockDb["previews"] = {};
  for (const v of versions.filter((x) => x.status === "PUBLISHED")) {
    for (const file of v.files) {
      const table = tableFor(v, file.path);
      if (!table) continue;
      const { columns, preview, rowsSampled, truncated, columnsTruncated } = profileCsv(table.text, file.path, table.hints);
      previews[file.file_id] = { status: "READY", column_profile: { format: "csv", rows_sampled: rowsSampled, truncated, columns_truncated: columnsTruncated, columns }, preview, generated_at: seedTime };
    }
  }

  const uploadSessions: Schemas["UploadSession"][] = seedDatasets
    .filter((d) => d.fixture !== null)
    .map((d, i) => ({
      upload_session_id: sid(`220${i + 1}`),
      dataset_version_id: versionOf[d.id]!,
      status: "COMPLETED",
      expires_at: seedTime,
      files: versions.find((v) => v.dataset_id === d.id)!.files.map((f) => ({ file_id: f.file_id, path: f.path, status: f.status })),
    }));

  const validation = (versionId: string, profileId: string, outcome: ReturnType<typeof buildResult>): StoredValidation => ({
    validation_id: crypto.randomUUID(),
    dataset_version_id: versionId,
    profile_id: profileId,
    profile_version: "1.0.0",
    run_status: "COMPLETED",
    overall_status: outcome.overall_status,
    summary: outcome.summary,
    checks: outcome.checks,
    validator_version: "mock-1.0.0",
    input_fingerprint: hex(versionId.length + profileId.length),
    error: null,
    triggered_by: "AUTO_ON_PUBLISH",
    created_at: at(10),
    started_at: at(10),
    completed_at: at(11),
    polls: 0,
    outcome,
  });

  // 09_AI_READY_RULES §5.6 golden table: every fixture runs GENERIC_BASIC and TABULAR_ML_BASIC on publish.
  const both = (versionId: string, overrides: Parameters<typeof buildResult>[1] = {}) => [
    validation(versionId, "TABULAR_ML_BASIC", buildResult("TABULAR_ML_BASIC", overrides)),
    validation(versionId, "GENERIC_BASIC", buildResult("GENERIC_BASIC", overrides)),
  ];
  const validations: StoredValidation[] = [
    ...both(VERSION.battery),
    ...both(VERSION.batteryV10),
    ...both(VERSION.batteryV11),
    ...both(VERSION.openMaterials, {
      "provenance.presence": ["FAIL", "provenance 정보가 없습니다.", { sources: ["dataset.provenance", "README.md"] }],
    }),
    ...both(VERSION.qcLogs, {
      "semantics.units_codebook": ["FAIL", "UCUM 단위가 아닌 값이 있습니다.", { invalid: 2, fields: ["temperature_c", "pressure_kpa"] }],
    }),
    ...both(VERSION.sensors, {
      "metadata.completeness": ["FAIL", "필수 메타데이터가 누락되었습니다.", { required_missing: ["contact_email", "description", "keywords"], recommended_missing: ["domain", "keywords_min_3"] }],
    }),
  ];

  const requests: Schemas["AccessRequest"][] = [
    {
      access_request_id: REQUEST.seedApproved,
      dataset_id: DATASET.battery,
      dataset_title: "리튬이온 배터리 셀 사이클 시험 데이터",
      project_id: PROJECT.seed,
      project_name: "차세대 이차전지 소재 공동연구",
      requester_user_id: USER.aResearcher,
      requester_display_name: "김민준",
      requester_organization_id: ORG.a,
      owner_organization_id: ORG.b,
      purpose: "ACADEMIC_RESEARCH",
      purpose_detail: "배터리 열화 예측 모델의 학술 연구를 위해 사이클 데이터를 분석합니다.",
      operations: ["READ"],
      requested_days: 30,
      status: "APPROVED",
      history: [
        { status: "SUBMITTED", at: seedTime, by_user_id: USER.aResearcher, comment: null },
        { status: "APPROVED", at: seedTime, by_user_id: USER.bSteward, comment: null },
      ],
      access_grant_id: GRANT.seed,
      created_at: seedTime,
      updated_at: seedTime,
    },
  ];

  const grants: Schemas["AccessGrant"][] = [
    {
      access_grant_id: GRANT.seed,
      access_request_id: REQUEST.seedApproved,
      subject_type: "USER",
      subject_user_id: USER.aResearcher,
      project_id: PROJECT.seed,
      dataset_id: DATASET.battery,
      dataset_title: "리튬이온 배터리 셀 사이클 시험 데이터",
      subject_display_name: "김민준",
      project_name: "차세대 이차전지 소재 공동연구",
      purpose: "ACADEMIC_RESEARCH",
      operations: ["READ"],
      valid_from: seedTime,
      expires_at: later(2),
      granted_by: USER.bSteward,
      policy_version: "data_access@1.0.0",
      status: "ACTIVE",
      revoked_at: null,
      revoked_by: null,
      revocation_reason: null,
    },
  ];

  const actor = (id: string | null): Schemas["AuditEvent"]["actor"] => {
    const u = users.find((x) => x.user_id === id);
    return u
      ? { type: "USER", user_id: u.user_id, display_name: u.display_name, organization_id: u.organization_id }
      : { type: "SYSTEM", user_id: null, display_name: null, organization_id: null };
  };
  let tick = 0;
  const audit = (
    action: Schemas["AuditAction"],
    by: string | null,
    type: Schemas["ResourceType"],
    id: string,
    owner: string | null,
    projectId: string | null = null,
  ): Schemas["AuditEvent"] => ({
    audit_event_id: crypto.randomUUID(),
    occurred_at: at(tick++),
    action,
    result: "SUCCESS",
    reason: null,
    actor: actor(by),
    resource: { type, id, owner_organization_id: owner },
    project_id: projectId,
    policy_version: action === "ACCESS_APPROVED" ? "data_access@1.0.0" : null,
    source_event_id: crypto.randomUUID(),
    source_event_type: "seed.v1",
    trace_id: crypto.randomUUID().replaceAll("-", ""),
    details: {},
  });

  // Audit rows derive from the events the real seeds publish (M09 §7.1).
  const seedAudit: Schemas["AuditEvent"][] = [
    audit("PROJECT_CREATED", USER.aResearcher, "PROJECT", PROJECT.seed, ORG.a, PROJECT.seed),
    audit("PROJECT_MEMBER_ADDED", USER.aResearcher, "PROJECT_MEMBER", USER.bResearcher, ORG.b, PROJECT.seed),
    ...seedDatasets.flatMap((d) => [
      audit("DATASET_CREATED", STEWARD[d.owner]!, "DATASET", d.id, d.owner),
      ...(d.fixture ? [audit("DATASET_VERSION_PUBLISHED", STEWARD[d.owner]!, "DATASET_VERSION", versionOf[d.id]!, d.owner)] : []),
    ]),
    ...batteryHistory.filter((v) => v.status === "PUBLISHED").map((v) => audit("DATASET_VERSION_PUBLISHED", STEWARD[ORG.b]!, "DATASET_VERSION", v.dataset_version_id, ORG.b)),
    ...validations.map((v) => {
      const datasetId = versions.find((x) => x.dataset_version_id === v.dataset_version_id)!.dataset_id;
      const owner = datasets.find((d) => d.dataset_id === datasetId)!.owner_organization_id;
      return audit("READINESS_VALIDATION_COMPLETED", null, "READINESS_VALIDATION", v.validation_id, owner);
    }),
    audit("ACCESS_REQUESTED", USER.aResearcher, "ACCESS_REQUEST", REQUEST.seedApproved, ORG.b, PROJECT.seed),
    audit("ACCESS_APPROVED", USER.bSteward, "ACCESS_GRANT", GRANT.seed, ORG.b, PROJECT.seed),
  ];

  const expiresIso = later(2);
  const expiresText = `${expiresIso.slice(0, 10)} ${expiresIso.slice(11, 16)}`;

  return {
    organizations,
    users: users.map((u) => ({ ...u, updated_at: seedTime })),
    projects: [
      {
        project_id: PROJECT.seed,
        name: "차세대 이차전지 소재 공동연구",
        status: "ACTIVE",
        visibility: "PRIVATE",
        lead_organization_id: ORG.a,
        updated_at: seedTime,
        description: "Seed project shared by 한국에너지기술연구원 and 한국재료연구원 (dev only).",
        keywords: [],
        start_date: null,
        end_date: null,
        organizations: [
          { organization_id: ORG.a, name: "한국에너지기술연구원", role: "LEAD" },
          { organization_id: ORG.b, name: "한국재료연구원", role: "PARTNER" },
        ],
        created_by: USER.aResearcher,
        created_at: seedTime,
        archived_at: null,
      },
    ],
    projectMembers: [
      { project_id: PROJECT.seed, user_id: USER.aResearcher, display_name: "김민준", organization_id: ORG.a, organization_name: "한국에너지기술연구원", role: "PROJECT_OWNER", joined_at: seedTime, added_by: USER.aResearcher },
      { project_id: PROJECT.seed, user_id: USER.bResearcher, display_name: "최유진", organization_id: ORG.b, organization_name: "한국재료연구원", role: "RESEARCHER", joined_at: seedTime, added_by: USER.aResearcher },
    ],
    datasets,
    versions,
    uploadSessions,
    requests,
    grants,
    validations,
    audit: seedAudit,
    contributors: CONTRIBUTORS.map(([dataset_id, user_id, role, affiliation_organization_id], i) => ({ dataset_id, user_id, role, affiliation_organization_id, position: CONTRIBUTORS.filter((c, j) => j < i && c[0] === dataset_id).length })),
    vocabulary: [...VOCABULARY],
    previews,
    objects: {},
    notifications: [
      // M09 §7.3 templates; 10_SEED_DATA §7: a.researcher's inbox holds exactly one ACCESS_EXPIRING.
      { notification_id: sid("7001"), user_id: USER.aResearcher, type: "ACCESS_EXPIRING", title: `"리튬이온 배터리 셀 사이클 시험 데이터" 접근 권한이 ${expiresText} UTC에 만료됩니다`, link: "/commons/access?tab=grants", read: false, created_at: at(20) },
      { notification_id: sid("7002"), user_id: USER.bResearcher, type: "PROJECT_INVITATION", title: `"차세대 이차전지 소재 공동연구" 프로젝트에 참여자로 추가되었습니다`, link: `/commons/projects/${PROJECT.seed}`, read: false, created_at: at(2) },
    ],
  };
}
