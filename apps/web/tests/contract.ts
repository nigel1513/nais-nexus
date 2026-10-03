import { readFileSync } from "node:fs";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import YAML from "yaml";

/** Validates mock HTTP responses against NAIS_PRD/contracts/openapi.yaml (1.2.0) — M10-AT-03/08 contract guard. */
const specPath = path.resolve(import.meta.dirname, "../../../NAIS_PRD/contracts/openapi.yaml");
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const spec: Json = YAML.parse(readFileSync(specPath, "utf8"));

const ROOT = "openapi";
function rewriteRefs(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(rewriteRefs);
  if (node && typeof node === "object") {
    return Object.fromEntries(
      Object.entries(node).map(([k, v]) => [k, k === "$ref" && typeof v === "string" && v.startsWith("#/") ? `${ROOT}${v}` : rewriteRefs(v)]),
    );
  }
  return node;
}

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema({ $id: ROOT, components: { schemas: rewriteRefs(spec.components.schemas) } });
// Inside components.schemas, refs are "#/components/schemas/X" — rewritten to "openapi#/..." above, which resolves in the added root.

export const SPEC_VERSION: string = spec.info.version;

const templates = Object.keys(spec.paths).map((template) => ({
  template,
  regex: new RegExp(`^${template.replace(/\{[^}]+\}/g, "[^/]+")}$`),
}));

function responseSchema(operation: Json, status: number): unknown {
  const entry = operation.responses?.[String(status)];
  if (!entry) return undefined;
  const resolved = entry.$ref ? spec.components.responses[String(entry.$ref).split("/").pop()!] : entry;
  return resolved.content?.["application/json"]?.schema;
}

const cache = new Map<unknown, ReturnType<typeof ajv.compile>>();
function validatorFor(schema: unknown) {
  let v = cache.get(schema);
  if (!v) {
    v = ajv.compile(rewriteRefs(schema) as object);
    cache.set(schema, v);
  }
  return v;
}

/** Returns a list of violations (empty = response conforms). Paths are relative to the API base (e.g. "/me"). */
export function checkResponse(method: string, apiPath: string, status: number, body: unknown): string[] {
  const match = templates.find((t) => t.regex.test(apiPath));
  if (!match) return [`${method} ${apiPath}: path not in openapi`];
  const operation = spec.paths[match.template][method.toLowerCase()];
  if (!operation) return [`${method} ${match.template}: method not in openapi`];
  let schema = responseSchema(operation, status);
  if (!schema && status >= 400) schema = { $ref: "#/components/schemas/ErrorEnvelope" };
  const declared = operation.responses?.[String(status)];
  if (!declared && status < 400) return [`${method} ${match.template}: status ${status} not declared`];
  const binary = declared?.content && !declared.content["application/json"]; // e.g. exportNotes' application/zip
  if (!schema && binary) return [];
  if (!schema) return status === 204 || body === null || body === "" ? [] : [`${method} ${match.template} ${status}: unexpected body`];
  const validate = validatorFor(schema);
  if (validate(body)) return [];
  return (validate.errors ?? []).map((e) => `${method} ${match.template} ${status}: ${e.instancePath || "/"} ${e.message}`);
}

/** Validates a value against a named components.schemas entry (used for seed fixtures that no handler serves yet). */
export function checkSchema(name: string, value: unknown): string[] {
  const validate = validatorFor({ $ref: `#/components/schemas/${name}` });
  return validate(value) ? [] : (validate.errors ?? []).map((e) => `${name}: ${e.instancePath || "/"} ${e.message}`);
}
