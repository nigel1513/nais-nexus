"""One-off, deterministic edit of NAIS_PRD/contracts/openapi.yaml 1.1.1 -> 1.2.0 (W1-D3).

Text-level edit (keeps the file's flow style and comments); idempotent; verifies the result with yaml.safe_load.
Usage: uv run python packages/contracts/changes/openapi_1_2_0.py NAIS_PRD/contracts/openapi.yaml
"""

import re
import sys
from pathlib import Path

import yaml

ERROR = '{ $ref: "#/components/responses/Error" }'
PUBLIC_OPS = {"healthLive", "healthReady"}
EXTRA: dict[str, tuple[str, ...]] = {
    "listOrganizationMembers": ("404",),
    "listUsers": ("422",),
    "updateProject": ("404", "422"),
    "archiveProject": ("404",),
    "addProjectMember": ("404",),
    "updateProjectMemberRole": ("404", "422"),
    "listProjects": ("422",),
    "searchDatasets": ("422", "503"),
    "updateDataset": ("404", "409"),
    "listDatasetVersions": ("404",),
    "createDatasetVersion": ("404",),
    "createUploadSession": ("404", "503"),
    "completeUploadSession": ("403", "404", "503"),
    "deleteDraftFile": ("503",),
    "publishDatasetVersion": ("404",),
    "startReadinessValidation": ("404", "503"),
    "getReadiness": ("503",),
}
PROPERTY_INSERTS = (  # (anchor line, line inserted right after it)
    (
        '        lead_organization_id: { $ref: "#/components/schemas/Id" }\n'
        '        my_role: { oneOf: [ { $ref: "#/components/schemas/ProjectRole" }, { type: "null" } ] }\n',
        "        lead_organization_name: { type: string }\n",
    ),
    (
        '        subject_user_id: { $ref: "#/components/schemas/Id" }\n'
        '        project_id: { $ref: "#/components/schemas/Id" }\n'
        '        dataset_id: { $ref: "#/components/schemas/Id" }\n'
        "        dataset_title: { type: string }\n",
        "        subject_display_name: { type: string }\n        project_name: { type: string }\n",
    ),
)
UPLOAD_REQUIRED_OLD = "            required: [file_id, path, status, upload]\n"
UPLOAD_REQUIRED_NEW = "            required: [file_id, path, status]\n"


def _takes_cursor(op: dict) -> bool:
    return any(
        p.get("$ref") == "#/components/parameters/Cursor"
        or (p.get("in") == "query" and p.get("name") == "cursor")
        for p in op.get("parameters", [])
    )


def wanted_statuses(spec: dict) -> dict[str, set[str]]:
    wanted: dict[str, set[str]] = {}
    for item in spec["paths"].values():
        for method, op in item.items():
            if method not in ("get", "post", "put", "patch", "delete"):
                continue
            op_id = op["operationId"]
            codes = set(EXTRA.get(op_id, ()))
            if op_id not in PUBLIC_OPS and op.get("security") != []:
                codes.add("401")
            if _takes_cursor(op):
                codes.add("422")
            wanted[op_id] = codes
    return wanted


def add_responses(lines: list[str], op_id: str, codes: set[str]) -> None:
    start = next(i for i, line in enumerate(lines) if line.strip() == f"operationId: {op_id}")
    resp = next(i for i in range(start, len(lines)) if lines[i].strip() == "responses:")
    resp_indent = len(lines[resp]) - len(lines[resp].lstrip())
    key_indent = " " * (resp_indent + 2)
    key_re = re.compile(rf'^{key_indent}"(\d{{3}})":')
    end = resp + 1
    last = resp
    while end < len(lines):
        line = lines[end]
        if line.strip() and len(line) - len(line.lstrip()) <= resp_indent:
            break
        if line.strip():
            last = end
        end += 1
    keys = {i: m.group(1) for i in range(resp + 1, last + 1) if (m := key_re.match(lines[i]))}
    for code in sorted(codes - set(keys.values()), reverse=True):
        before = [i for i, existing in keys.items() if existing > code]
        at = min(before) if before else last + 1
        lines.insert(at, f'{key_indent}"{code}": {ERROR}\n')
        keys = {(i + 1 if i >= at else i): c for i, c in keys.items()}
        keys[at] = code
        last += 1


def main(path: Path) -> None:
    text = path.read_text(encoding="utf-8")
    text = text.replace("\n  version: 1.1.1\n", "\n  version: 1.2.0\n", 1)
    for anchor, insert in PROPERTY_INSERTS:
        if anchor + insert not in text:
            assert text.count(anchor) == 1, anchor
            text = text.replace(anchor, anchor + insert)
    if UPLOAD_REQUIRED_OLD in text:
        assert text.count(UPLOAD_REQUIRED_OLD) == 1
        text = text.replace(UPLOAD_REQUIRED_OLD, UPLOAD_REQUIRED_NEW)
    lines = text.splitlines(keepends=True)
    for op_id, codes in wanted_statuses(yaml.safe_load(text)).items():
        add_responses(lines, op_id, codes)
    text = "".join(lines)
    spec = yaml.safe_load(text)
    assert spec["info"]["version"] == "1.2.0"
    wanted = wanted_statuses(spec)
    for item in spec["paths"].values():
        for method, op in item.items():
            if method in ("get", "post", "put", "patch", "delete"):
                missing = wanted[op["operationId"]] - set(op["responses"])
                assert not missing, (op["operationId"], missing)
    path.write_text(text, encoding="utf-8")
    print("openapi.yaml is at 1.2.0")


if __name__ == "__main__":
    main(Path(sys.argv[1]))
