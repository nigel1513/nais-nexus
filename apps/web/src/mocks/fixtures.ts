import type { Schemas } from "@/shared/api/types";
import { buildResult } from "./readiness-results";
import { SEED_FILES } from "./seed-files";
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
export const VERSION = { battery: sid("2101"), openMaterials: sid("2102"), qcLogs: sid("2103"), sensors: sid("2104"), electrolyte: sid("2105") } as const;
export const REQUEST = { seedApproved: sid("3001") } as const;
export const GRANT = { seed: sid("4001") } as const;

const users: Omit<MockUser, "updated_at">[] = [
  { user_id: USER.admin, display_name: "NAIS Admin", email: "admin@nais.local", organization_id: ORG.nais, org_roles: ["ORG_ADMIN"], platform_roles: ["PLATFORM_ADMIN"], status: "ACTIVE", membership_status: "ACTIVE" },
  { user_id: USER.aAdmin, display_name: "A Admin", email: "a.admin@inst-a.local", organization_id: ORG.a, org_roles: ["ORG_ADMIN"], platform_roles: [], status: "ACTIVE", membership_status: "ACTIVE" },
  { user_id: USER.aResearcher, display_name: "A Researcher", email: "a.researcher@inst-a.local", organization_id: ORG.a, org_roles: [], platform_roles: [], status: "ACTIVE", membership_status: "ACTIVE" },
  { user_id: USER.aSteward, display_name: "A Steward", email: "a.steward@inst-a.local", organization_id: ORG.a, org_roles: ["DATA_STEWARD"], platform_roles: [], status: "ACTIVE", membership_status: "ACTIVE" },
  { user_id: USER.bAdmin, display_name: "B Admin", email: "b.admin@inst-b.local", organization_id: ORG.b, org_roles: ["ORG_ADMIN"], platform_roles: [], status: "ACTIVE", membership_status: "ACTIVE" },
  { user_id: USER.bResearcher, display_name: "B Researcher", email: "b.researcher@inst-b.local", organization_id: ORG.b, org_roles: [], platform_roles: [], status: "ACTIVE", membership_status: "ACTIVE" },
  { user_id: USER.bSteward, display_name: "B Steward", email: "b.steward@inst-b.local", organization_id: ORG.b, org_roles: ["DATA_STEWARD"], platform_roles: [], status: "ACTIVE", membership_status: "ACTIVE" },
  { user_id: USER.bDisabled, display_name: "B Disabled", email: "b.disabled@inst-b.local", organization_id: ORG.b, org_roles: [], platform_roles: [], status: "ACTIVE", membership_status: "DISABLED" },
];

/** Mock login choices (M10 §13: "seed 사용자 선택 드롭다운"). */
export const SEED_USERS = users.map((u) => ({ id: u.user_id, label: u.display_name, email: u.email }));

const STEWARD = { [ORG.a]: USER.aSteward, [ORG.b]: USER.bSteward } as Record<string, string>;
const ORG_NAME = { [ORG.nais]: "NAIS", [ORG.a]: "Institute A", [ORG.b]: "Institute B" } as Record<string, string>;

/** seed_data.py CLEAN_METADATA / metadata_for(): the same text every seed dataset receives, with per-fixture degradations. */
const CLEAN_METADATA = {
  description: "연료전지용 고분자 전해질 막 시편 1,000개에 대해 온도와 압력을 측정한 표 형식 데이터셋이다. 재료 코드는 codebook에 정의되어 있다.",
  keywords: ["fuel-cell", "membrane", "temperature", "pressure"],
  domain: "materials" as string | null,
  license: "CC-BY-4.0",
  usage_policy: "학술 연구 및 AI 학습 목적에 한해 사용한다. 재배포 금지. 결과 공개 시 출처를 표기한다." as string | null,
  contact_email: "steward@inst-b.example" as string | null,
  provenance: "Institute B 연료전지 실험실의 환경 챔버(모델 EC-200)에서 2026년 1월 1일 1분 간격으로 자동 수집한 측정값." as string | null,
};
type Fixture = "clean_tabular" | "missing_metadata" | "invalid_units" | "missing_provenance" | null;
function metadataFor(fixture: Fixture) {
  const m = { ...CLEAN_METADATA };
  if (fixture === "missing_metadata") Object.assign(m, { description: "측정 데이터", keywords: [], domain: null, contact_email: null });
  if (fixture === "missing_provenance") m.provenance = null;
  return m;
}

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
    { organization_id: ORG.nais, code: "nais", name: "NAIS", type: "PLATFORM_OPERATOR", ror_id: null, homepage_url: null, member_count: 1, dataset_count: 0, created_at: seedTime },
    { organization_id: ORG.a, code: "inst-a", name: "Institute A", type: "RESEARCH_INSTITUTE", ror_id: null, homepage_url: null, member_count: 3, dataset_count: 2, created_at: seedTime },
    { organization_id: ORG.b, code: "inst-b", name: "Institute B", type: "RESEARCH_INSTITUTE", ror_id: null, homepage_url: null, member_count: 4, dataset_count: 3, created_at: seedTime },
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
    { id: DATASET.battery, owner: ORG.b, title: "Battery Cycling Measurements", level: "CONTROLLED", purposes: ["ACADEMIC_RESEARCH", "AI_TRAINING"], maxDays: 180, fixture: "clean_tabular" },
    { id: DATASET.openMaterials, owner: ORG.b, title: "Open Materials Properties", level: "PUBLIC", purposes: ALL_PURPOSES, maxDays: 365, fixture: "missing_provenance" },
    { id: DATASET.qcLogs, owner: ORG.b, title: "Inst-B Internal QC Logs", level: "INTERNAL", purposes: ["ACADEMIC_RESEARCH"], maxDays: 90, fixture: "invalid_units" },
    { id: DATASET.sensors, owner: ORG.a, title: "Facility Sensor Streams", level: "SENSITIVE", purposes: ["ACADEMIC_RESEARCH"], maxDays: 30, fixture: "missing_metadata" },
    { id: DATASET.electrolyte, owner: ORG.a, title: "Electrolyte Screening (draft)", level: "CONTROLLED", purposes: ["AI_TRAINING"], maxDays: 90, fixture: null },
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
    ...metadataFor(d.fixture),
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
    return {
      dataset_version_id: versionOf[d.id]!,
      dataset_id: d.id,
      version_label: "v1",
      status: published ? "PUBLISHED" : "DRAFT",
      published_at: published ? seedTime : null,
      change_note: "Seed data (10_SEED_DATA.md)",
      files,
      file_count: files.length,
      total_bytes: files.reduce((n, f) => n + f.size_bytes, 0),
      manifest_sha256: published ? (seeded?.manifest_sha256 ?? null) : null,
      created_at: seedTime,
    };
  });

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
      dataset_title: "Battery Cycling Measurements",
      project_id: PROJECT.seed,
      project_name: "Seed: Battery Materials Joint Study",
      requester_user_id: USER.aResearcher,
      requester_display_name: "A Researcher",
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
      dataset_title: "Battery Cycling Measurements",
      subject_display_name: "A Researcher",
      project_name: "Seed: Battery Materials Joint Study",
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
        name: "Seed: Battery Materials Joint Study",
        status: "ACTIVE",
        visibility: "PRIVATE",
        lead_organization_id: ORG.a,
        updated_at: seedTime,
        description: "Seed project shared by Institute A and Institute B (dev only).",
        keywords: [],
        start_date: null,
        end_date: null,
        organizations: [
          { organization_id: ORG.a, name: "Institute A", role: "LEAD" },
          { organization_id: ORG.b, name: "Institute B", role: "PARTNER" },
        ],
        created_by: USER.aResearcher,
        created_at: seedTime,
        archived_at: null,
      },
    ],
    projectMembers: [
      { project_id: PROJECT.seed, user_id: USER.aResearcher, display_name: "A Researcher", organization_id: ORG.a, organization_name: "Institute A", role: "PROJECT_OWNER", joined_at: seedTime, added_by: USER.aResearcher },
      { project_id: PROJECT.seed, user_id: USER.bResearcher, display_name: "B Researcher", organization_id: ORG.b, organization_name: "Institute B", role: "RESEARCHER", joined_at: seedTime, added_by: USER.aResearcher },
    ],
    datasets,
    versions,
    uploadSessions,
    requests,
    grants,
    validations,
    audit: seedAudit,
    notifications: [
      // M09 §7.3 templates; 10_SEED_DATA §7: a.researcher's inbox holds exactly one ACCESS_EXPIRING.
      { notification_id: sid("7001"), user_id: USER.aResearcher, type: "ACCESS_EXPIRING", title: `"Battery Cycling Measurements" 접근 권한이 ${expiresText} UTC에 만료됩니다`, link: "/commons/access?tab=grants", read: false, created_at: at(20) },
      { notification_id: sid("7002"), user_id: USER.bResearcher, type: "PROJECT_INVITATION", title: `"Seed: Battery Materials Joint Study" 프로젝트에 참여자로 추가되었습니다`, link: `/commons/projects/${PROJECT.seed}`, read: false, created_at: at(2) },
    ],
  };
}
