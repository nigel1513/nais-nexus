# M09 Audit & Notification (`apps/api/modules/audit`)

Spec: `NAIS_PRD/modules/M09_audit_notification.md`. Schema `audit`.

## What it does
- Subscribes `audit_writer` and `notifier` to **every** event type in `contracts/events/index.json` (42).
  Each claims `audit.processed_events(event_id, handler)` in the same transaction as its writes (D-006).
- `audit_writer`: `mapping.AUDIT_RULES` -> `audit.audit_events` (append-only). `expiring_soon` and
  `validation.started` are claimed but not audited. Unmapped types are claimed and logged as warnings.
- `notifier`: `notification_rules` -> `audit.notifications` + `audit.email_deliveries` (PENDING).
  Inactive recipients are skipped. If the email address lookup fails for one recipient, the in-app notification
  is kept and only that recipient's email is skipped (warning logged).
- Contract 1.6.0 (workspace M13, notes M14): every event is audited. Notifications: publish requested -> the
  DATA_STEWARDs of each approval-slot organization; publish decided -> the requester (a system REJECT with
  `failure_reason` reads as a failed publication); run failed -> the run starter; DATASET-scope comment -> the owner
  organization's DATA_STEWARDs (project-side threads notify nobody); note submitted -> the snapshot witnesses; note
  rejected / signed -> the recorder. Input, recipe, run-succeeded, output and note-viewed events are audit-only.
  For these rules the acting user is never notified of their own action (a failed run excepted).
- CHECK constraints on action / resource_type / notification type hold frozen enum copies; `audit_0003` widened them
  to contract 1.6.0. A new contract enum value needs a new migration (`test_schema` inserts every current value).

## Append-only guarantee
Two independent layers, both from migration `audit_0002`:
1. Grants: `UPDATE, DELETE, TRUNCATE` on `audit.audit_events` are REVOKEd from `nais_app`; it holds only
   `INSERT, SELECT`.
2. Triggers: `audit.forbid_mutation()` blocks row UPDATE/DELETE and statement TRUNCATE even for a role that
   regains the privileges.
Code must never update, delete or `SELECT ... FOR UPDATE` audit rows (no UPDATE privilege). There is no audit
deletion job. Code review checklist item. Other modules never write audit tables; audit is event-driven only.

## Ports and the fail-closed fallback
`ports.py` re-exports the provider public ports M09 consumes (`api.modules.identity.public.IdentityQueryPort`,
`api.modules.project.public.ProjectQueryPort`, `api.modules.catalog.public.CatalogQueryPort`; D-038) and defines
`GrantQueryPort` locally until M04 ships `api.modules.governance.public` (Wave 2, `TODO(Wave 2)`).
Providers register in their `wire()`.
- `AUDIT_ALLOW_FAKE_PORTS` (default `false`) controls what happens when a port is not provided:
  - flag off: an unwired identity/project/catalog port raises (fail closed, `PortNotProvided`); an unwired
    `GrantQueryPort` resolves to an EMPTY grants port (no grants, warned once). This is the Wave 1 production
    state because M04 is absent, so no one gains access through grants.
  - flag on (tests / local dev): `fakes.py` seed data is used for every missing port, with a warning once per port.

## Visibility rules (`GET /audit-events`)
Applied as a mandatory SQL predicate (`visibility.audit_scope`), never as post-filtering:
- PLATFORM_ADMIN sees everything.
- ORG_ADMIN / DATA_STEWARD see rows whose resource owner org is theirs, plus rows whose actor org is theirs
  except download actions (`FILE_DOWNLOADED`, `DOWNLOAD_DENIED`): a download of another org's data is visible
  only to the owning org.
- Everyone sees their own actions. With a `project_id` filter on a project they are a member of they also see
  that project's rows, except `DOWNLOAD_DENIED`. A regular user filtering a project they are not a member of
  gets 403; staff get a narrowed result (200).
- ARCHIVED-project membership: membership is evaluated with `ProjectQueryPort.list_project_ids_for_member`, which
  INCLUDES archived projects, so members keep read access to the audit trail of an archived project. Do not use
  `is_active_member` for this (it is false for archived projects).
- `organization_id` filter outside the caller's own org: 403 (non-admin).
- `details` never contains `purpose_detail` (stripped at any depth when written).

## Notification and email lifecycle
- Mail is sent by the `audit_send_emails` Dramatiq actor (enqueued after commit; `max_retries=0`, queue `audit`,
  `time_limit` tied to the lease) and by the 5-minute `audit.send_emails` scan, which also picks up PENDING rows
  that were never kicked.
- Lease: a short transaction claims due rows with `FOR UPDATE SKIP LOCKED`, increments `attempts` and sets
  `next_attempt_at` to a lease end sized from the SMTP timeout and batch size. SMTP I/O happens outside any
  transaction. The outcome transaction is guarded by the attempt count, so a stale outcome (after the lease
  expired and another worker re-claimed) is dropped.
- At-least-once on worker death: if a worker dies after claiming or sending, the lease expires and the row is
  re-claimed, so a rare duplicate email is possible (never a lost one).
- Release of unsent claims: before each send the remaining lease is checked; when it is too short the batch
  stops, and claimed-but-never-sent rows are released (`attempts - 1`, `next_attempt_at = now`) in a `finally`,
  including on exceptions/SIGTERM. A row whose outcome transaction failed is NOT released, because the mail may
  have gone out.
- State machine: PENDING -> SENT on success; on failure attempts+1 with backoff 1m, 5m, 15m, 1h; at 5 attempts
  -> FAILED. Recipient addresses are scrubbed (case-insensitive) from stored error text, bounded to 2000 chars.
  Korean bodies use quoted-printable/base64 transfer encoding.
- Purge: `audit.purge_notifications` (daily) deletes READ notifications whose `created_at` is older than `NOTIFICATION_RETENTION_DAYS` (age is measured from `created_at`, not `read_at`)
  in short `SKIP LOCKED` batches (email rows cascade). It is registered with `run_immediately=True` because the
  scheduler clock is not persisted and frequent redeploys would otherwise never reach the first daily run.

## Adding an event type (other modules)
Ask the M09 owners to add a row to `mapping.AUDIT_RULES` (and `notification_rules._BUILDERS` if it notifies).
Until then the event is claimed and a `no audit mapping for event type` warning is logged.

## Env
`SMTP_HOST` (mailpit), `SMTP_PORT` (1025), `SMTP_FROM`, `NOTIFICATION_EMAIL_ENABLED`, `NOTIFICATION_RETENTION_DAYS`,
`NAIS_PUBLIC_BASE_URL`, `AUDIT_ALLOW_FAKE_PORTS`. Dev mail UI: http://localhost:21052 (nais / nais).

## Known limitations
- FILE_DOWNLOADED means "URL issued" (D-017). Names and owner orgs are copied at record time.
- Reading audit is not itself audited (P0). Notifications are Korean only.
- Until M04 ships, grants-based visibility/recipients are empty in production (flag off).
- Email delivery is at-least-once (duplicates possible after worker death); the scheduler runs jobs sequentially.
- Naive `from`/`to` datetimes are accepted on the audit list (treated as UTC by the DB layer, not rejected).
- No `created_at` index for the purge scan; `audit_events.audit_event_id` has no server default (writers supply ids).
