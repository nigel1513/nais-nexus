# M07-lite: One Shared Jupyter + Research-Note Drafting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Run one shared JupyterLab container behind the gateway. Researchers open it from the portal straight into a per-user, per-project folder. That day's saved notebooks feed the research-note LLM draft, which already exists and waits on `NotebookActivityPort`.

**Architecture:**
- JupyterLab container `notebook` (compose service and volume `notebookwork`) is served under `/notebooks/` on the main gateway. Auth is one shared token in `.env`; the user approved demo-level security on 2026-10-03 (option A).
- The backend reads notebooks only through the Jupyter REST contents API (`http://notebook:8888/notebooks/api/contents/...`). There is no shared filesystem.
- A notes adapter `JupyterNotebooks` implements the existing `NotebookActivityPort` (`apps/api/modules/notes/public.py`).
- The web server (Next route handler) creates the folder and copies the project's PUBLIC/INTERNAL input files into it at open time, then redirects into JupyterLab.
- 21051 runs the web in mock mode, so the mock `draftNote` asks the real api through two internal endpoints protected by a shared header token. That way the real Python reader, prompt, LLM and parser are the only implementation.

**Tech Stack:** FastAPI/httpx (api), Next.js route handlers (web), `quay.io/jupyter/scipy-notebook` (pinned tag), nginx.

**Spec:** this plan carries its own design. The user approved it in chat on 2026-10-03 ("네"). The full M07 plan `docs/superpowers/plans/2026-10-01-m07-notebooks.md` stays the later "B" upgrade path.

## Global Constraints
- **Contract:** 1.8.0. Add 2 internal operations only. Record the decision as D-049 in `NAIS_PRD/11_DECISION_LOG.md`. 1.5.0 stays reserved for the full M07.
- **Folder layout:** `work/<user_id>/<project_id>/`, ids as canonical UUID strings.
  - `README.md` holds the project name.
  - Input files go under `work/<user_id>/<project_id>/data/`.
  - Only `.ipynb` files directly in the project folder or its subfolders count as activity. `data/` is excluded.
- **Activity rules:**
  - "That day" = a notebook's `last_modified` falls on the given day in Asia/Seoul.
  - Cells are read as `source_head` (≤400 chars) plus output kinds, count and has_error.
  - Output data and text are never read into the activity.
- **Data rules:**
  - Copy only inputs whose `access_level` is PUBLIC or INTERNAL. CONTROLLED and SENSITIVE are skipped, and the skip is listed in README.md.
  - Copy only the input's primary tabular file: skip basenames starting with "_", then take the largest VERIFIED csv/parquet.
  - Maximum 50 MiB per file. Larger files are skipped and listed.
- **Internal endpoints:** require header `X-NAIS-Internal-Token` equal to `NAIS_INTERNAL_TOKEN`. Return 404 when the setting is empty, and 403 when the token is wrong.
- **Secrets:** never put the Jupyter token in client bundles or logs. The redirect URL carries it once, and Jupyter turns it into a cookie.
- **Repo is public:** never write the server's public IP. The private GPU host 192.168.0.2 is fine.
- **Commits:** one per task. The message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Korean UI:** no 데모/샘플 wording.

## Review Focus
1. **Path safety.** user_id and project_id must be validated UUIDs before building any Jupyter path; no `..`. Notebook names in activity are display-only.
2. **Data minimisation.** Output values never reach the LLM, including `text/plain` execute_result and stream text. Test with a notebook whose outputs contain secrets.
3. **Jupyter unavailable** (container down or wrong token):
   - The portal button shows "노트북 서버에 연결할 수 없습니다".
   - `draft_source_count` falls back to 0 (fail-soft).
   - The daily schedule logs and retries.
4. **Mock-mode bridge.** If `NAIS_INTERNAL_API_URL` is unset, the mock keeps today's deterministic seeded behaviour. If it is set, it uses the real counts and drafts.
5. **The copy is idempotent.** Re-opening doesn't re-upload unchanged files (compare size), and a large or slow input doesn't block the redirect beyond 20 s. Remaining files are listed as "복사 중 건너뜀".

---

### Task 1: api — Jupyter client, `JupyterNotebooks` adapter, internal endpoints (contract 1.8.0)

**Files:**
- `apps/api/platform/jupyter.py`: `JupyterClient` (httpx, `NAIS_JUPYTER_URL`, `NAIS_JUPYTER_TOKEN`, timeout 10 s) with `list_dir(path)`, `get_notebook(path)` and `ensure_dir(path)`. Settings and `.env.example` entries.
- `apps/api/modules/notes/adapters.py`: `JupyterNotebooks(NotebookActivityPort)`.
  - `list_notebook_activity(user_id, project_id, day)` walks `work/<u>/<p>` recursively (max depth 3, max 200 entries, skip `data/` and `.ipynb_checkpoints`). It keeps notebooks whose KST `last_modified` date equals `day` and builds `NotebookActivity` (title = file stem, `version_id=None`, `saved_at=last_modified`, cells per the rules).
  - `list_notebook_authors(day)` lists `work/*/*` (UUID-named folders only) and returns pairs that have ≥1 notebook that day.
- `apps/api/modules/notes/wiring.py`: provide `JupyterNotebooks` when `NAIS_JUPYTER_URL` is set; otherwise keep `NoNotebooks`.
- Internal router `apps/api/modules/notes/routes/internal.py`:
  - `GET /internal/notes/notebook-activity?user_id&project_id&day` → `{count, notebooks:[{title, saved_at, cell_count}]}`
  - `POST /internal/notes/draft-sections` with body `{user_id, project_id, day, project_name}`. It reads activity through the port, builds the prompt with the existing `drafting/prompt.py`, calls the LLM, and parses with `drafting/parse.py`. It returns `{sections: {SECTION: [{text, evidence:[{label, at}]}]}}` and writes nothing to the DB.
  - Errors: 422 `NO_NOTEBOOK_ACTIVITY`, 503 `LLM_UNAVAILABLE`, 503 `DEPENDENCY_UNAVAILABLE` when Jupyter is down.
- Contract: openapi 1.8.0 with operations `getInternalNotebookActivity` and `draftInternalNoteSections` under tag `Internal`, plus D-049.
- Tests (`apps/api/modules/notes/tests/test_jupyter.py`, `test_internal.py`), with Jupyter faked by `httpx.MockTransport`:
  - day filtering in KST;
  - `data/` and checkpoints excluded;
  - output values never present: a secret in `text/plain`, a stream and an image, all asserted absent;
  - invalid UUID folder names ignored;
  - token header 404/403/200;
  - draft-sections with a fake LLM;
  - Jupyter down → 503 and `draft_source_count` 0.
- Commit `feat(notes): read the shared Jupyter as the drafting source; internal draft endpoints`.

### Task 2: infra — `notebook` service and gateway route

**Files:**
- `docker-compose.yml`: service `notebook`.
  - Image `quay.io/jupyter/scipy-notebook:2025-03-14` or a newer pinned tag (verify that the tag exists).
  - Command `start-notebook.py --ServerApp.base_url=/notebooks/ --IdentityProvider.token=${NAIS_JUPYTER_TOKEN} --ServerApp.terminals_enabled=False --ServerApp.allow_remote_access=True --ServerApp.root_dir=/home/jovyan`.
  - Volume `notebookwork:/home/jovyan/work`, `mem_limit` 4g, restart unless-stopped, no published port.
  - Add `NAIS_JUPYTER_URL`, `NAIS_JUPYTER_TOKEN`, `NAIS_INTERNAL_TOKEN` to the api/worker/web env.
  - Add `NAIS_INTERNAL_API_URL=http://api:8000` to the web env.
- `infra/nginx/nais.conf`: `location /notebooks/` → `http://notebook:8888` through a variable upstream like the others. Add WebSocket upgrade headers, `proxy_read_timeout 1d` and `client_max_body_size 100m`.
- `.env.example`: the new variables, with tokens left empty.
- Test: `test_env_example` passes. `docker compose config` is valid. The implementer must not start containers.
- Commit `feat(infra): one shared JupyterLab behind /notebooks/`.

### Task 3: web — open notebooks, nav, mock bridge

**Files:**
- Route handler `apps/web/src/app/notebooks-open/route.ts` (GET, server only):
  1. Session user and `?project=`, validated as UUIDs.
  2. Check membership through the app API (`getProject`): mock mode uses the mock store, real mode uses the api with the session token.
  3. `ensure_dir` for `work/<u>/<p>` and `data/`, and write `README.md`.
  4. For each input, check access and size and copy the primary file through the Jupyter contents API (base64 PUT, skip if same size), with a 20 s overall budget.
  5. 302 to `/notebooks/lab/tree/work/<u>/<p>?token=<token>`.
  - Errors redirect back with `?notebook_error=unavailable|forbidden`.
- `src/shared/ui/nav.ts`: the 노트북 item loses `soon`.
- `src/features/notebooks/notebooks-screen.tsx` at `/commons/notebooks`: my projects with a "노트북 열기" link. It also shows today's notebook count per project when available, using `getNote`'s `draft_source_count`, or hides it.
- Project workspace header: a "노트북 열기" button, also on the research-note page next to "AI 초안".
- Mock bridge in `src/mocks/handlers/notes.ts` and `notebook-activity.ts`:
  - When `process.env.NAIS_INTERNAL_API_URL` and `NAIS_INTERNAL_TOKEN` are set, `draft_source_count` comes from `GET /internal/notes/notebook-activity`, with a 2 s timeout and 0 on error.
  - `draftNote` calls `POST /internal/notes/draft-sections` and appends AI blocks (unaccepted, NOTEBOOK evidence) from the returned sections.
  - Map the api errors: 422 → `NO_NOTEBOOK_ACTIVITY`, 503 → `LLM_UNAVAILABLE` or `DEPENDENCY_UNAVAILABLE`.
  - The draft may run synchronously inside the mock; mark it DONE when it finishes.
  - Otherwise keep the seeded behaviour.
- Tests:
  - the route handler with fetch mocked: UUID validation, forbidden, copy skip rules, redirect;
  - the bridge on and off;
  - nav (`platform-shell.test.tsx`);
  - the e2e smoke for the `/commons/notebooks` axe check at 390px (the Jupyter link is not followed).
- Commit `feat(web): open the shared Jupyter from projects and notes; mock drafts use the real drafting service`.

### Task 4: deploy and live check (controller)
1. Before merging, commit the main checkout's pending infra edits, after reviewing them.
2. Merge with ff and push.
3. Pull the image and set the tokens in `.env`.
4. `docker compose up -d notebook`, rebuild api, worker and web, then reload the gateway.
5. Live check:
   - open from the portal;
   - create a notebook with markdown and code cells, then save;
   - "AI 초안" in the research note produces sections with NOTEBOOK evidence.
6. Write memory and report.
