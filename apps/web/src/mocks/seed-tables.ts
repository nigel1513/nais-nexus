import type { Hint } from "./previews";

/** Mock stand-ins for the tabular seed files, one per dataset topic (columns match each dataset's subject). */
const pad = (n: number, w: number) => String(n).padStart(w, "0");
const csv = (header: string[], n: number, row: (i: number) => (string | number)[]) => [header.join(","), ...Array.from({ length: n }, (_, i) => row(i).join(","))].join("\n");

/** Cycle-life test of lithium-ion cells: capacity fades slowly, temperature follows the chamber duty. */
export const batteryCycles = (rows: number) =>
  csv(["cycle", "capacity_ah", "voltage_v", "temp_c"], rows, (i) => [i + 1, (3.05 - i * 0.00042 - (i % 7) * 0.0006).toFixed(4), (3.62 + ((i * 7) % 11) * 0.004).toFixed(3), (24 + (i % 9) * 0.35).toFixed(2)]);
export const BATTERY_CYCLES_HINTS: Record<string, Hint> = {
  cycle: { type: "integer", description: "충방전 사이클 번호" },
  capacity_ah: { type: "number", unit: "A.h", description: "방전 용량", concept_iri: "http://qudt.org/vocab/quantitykind/ElectricCharge" },
  voltage_v: { type: "number", unit: "V", description: "평균 방전 전압", concept_iri: "http://qudt.org/vocab/quantitykind/Voltage" },
  temp_c: { type: "number", unit: "Cel", description: "셀 표면 온도", concept_iri: "http://qudt.org/vocab/quantitykind/Temperature" },
};
export const batteryCells = () => csv(["cell_id", "chemistry", "nominal_capacity_ah", "form_factor"], 12, (i) => [`C${pad(i + 1, 2)}`, i % 3 === 2 ? "NCM811/SiC" : "NCM811/Graphite", 3.0, "18650"]);
export const BATTERY_CELLS_HINTS: Record<string, Hint> = { cell_id: { type: "string" }, nominal_capacity_ah: { type: "number", unit: "A.h", description: "정격 용량" } };

export const openMaterials = () =>
  csv(["sample_id", "material", "density_g_cm3", "hardness_hv", "lattice_a_angstrom"], 480, (i) => [`OM${pad(i, 4)}`, ["Al2O3", "ZrO2", "Inconel718", "Ti6Al4V"][i % 4]!, (3.9 + (i % 13) * 0.31).toFixed(2), 180 + ((i * 17) % 1400), (2.86 + (i % 11) * 0.12).toFixed(3)]);
export const OPEN_MATERIALS_HINTS: Record<string, Hint> = {
  sample_id: { type: "string" },
  material: { type: "string", description: "시편 재질" },
  density_g_cm3: { type: "number", unit: "g/cm3", description: "밀도" },
  hardness_hv: { type: "number", unit: "[HV]", description: "비커스 경도" },
  lattice_a_angstrom: { type: "number", unit: "Ao", description: "격자상수 a (XRD)" },
};

/** Keeps temperature_c / pressure_kpa: the seed readiness result for this dataset flags their units. */
export const qcLogs = () =>
  csv(["batch_id", "line", "temperature_c", "pressure_kpa", "inspected_at"], 720, (i) => [`B${pad(i, 4)}`, `L${(i % 3) + 1}`, (180 + (i % 40) * 0.5).toFixed(1), (95 + (i % 25) * 0.8).toFixed(1), `2025-07-${pad((i % 28) + 1, 2)}T${pad(i % 24, 2)}:00:00Z`]);
export const QC_LOGS_HINTS: Record<string, Hint> = {
  batch_id: { type: "string" },
  line: { type: "string", description: "생산 라인" },
  temperature_c: { type: "number", unit: "degC", description: "공정 온도" },
  pressure_kpa: { type: "number", unit: "kilopascal", description: "공정 압력" },
  inspected_at: { type: "datetime" },
};

export const sensors = () =>
  csv(["sensor_id", "recorded_at", "humidity_pct", "temperature_c", "vibration_mm_s"], 900, (i) => [`HVAC-${(i % 4) + 1}`, `2026-02-${pad((Math.floor(i / 40) % 28) + 1, 2)}T${pad(Math.floor(i / 4) % 24, 2)}:${pad((i % 4) * 15, 2)}:00Z`, (38 + (i % 23) * 0.9).toFixed(1), (21 + (i % 17) * 0.3).toFixed(1), (0.4 + (i % 29) * 0.07).toFixed(2)]);
export const SENSORS_HINTS: Record<string, Hint> = {
  sensor_id: { type: "string" },
  recorded_at: { type: "datetime" },
  humidity_pct: { type: "number", unit: "%", description: "상대습도" },
  temperature_c: { type: "number", unit: "Cel", description: "실내 온도" },
  vibration_mm_s: { type: "number", unit: "mm/s", description: "진동 속도(RMS)" },
};
