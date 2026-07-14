# Production migration release — 2026-07-13

This release record reconciles the repository migration versions with the Lake & Pine
Supabase project after adding and hardening the premium operations schema.

## Current production history

The project reported exactly these applied migrations after the premium operations
release:

- `20260707042452 core`
- `20260707042519 content_seed`
- `20260713233006 service_planning_foundation`
- `20260713235942 production_schema_hardening`

The repository uses those same versioned filenames. Do not use a checkout that still
contains `0001_core.sql` or `0002_content_seed.sql`; those retired names create false
history drift even though the schema already exists.

## Applied premium operations change

The authenticated migration API applied
`20260713233006_service_planning_foundation.sql` after the release commit passed the
fresh PostgreSQL 17 verifier. The operation is additive and contains the
premium booking, territory, cleaner, availability, scheduling, service-case, refund,
outbox, RLS, and application-role foundation. The reviewed SHA-256 is
`1f94ab6067869a212e196dce0e66eccaae87d4fbf9eccf50eb6874ceb6a0c85e`
for the canonical LF-normalized Git blob. The authenticated API recorded a mixed-line-
ending payload SHA-256 of
`a31fe0ec9e305fd1e8520ce5dc6f81847e1cbb965a953d89bc07fc2190672952`;
removing carriage returns from the recorded payload produces the canonical Git hash.
Repository attributes now enforce LF for migration SQL so future Git and provider hashes
remain byte-for-byte reproducible.

The post-apply audit proved the restricted `lakeandpine_app` role, application CRUD,
RLS coverage, zero public table grants, zero app-owned public objects, and the complete
planning table set.

## Applied hardening change

The authenticated migration API applied
`20260713235942_production_schema_hardening.sql` after its release commit passed the
fresh PostgreSQL 17 verifier. It sets an explicit function search path,
removes redundant private-table policies, narrows public catalog policies to Supabase's
`anon` and `authenticated` client roles plus the server-only `lakeandpine_app` role,
and adds covering indexes for every foreign key reported by the production performance
advisor. Its canonical LF-normalized SHA-256 is
`ca69a8e182853cea91aedb289d83a054b1148aacf5a37beda98081f53ceb0b65`.

The exact preflight found the three expected earlier history rows, zero conflicting index
names, 14 legacy policies to replace, and six catalog policies. The migration then applied
once and the post-apply audit proved:

- zero security-advisor findings;
- zero duplicate application-role policy actions and zero legacy `app_all_*` policies;
- all 20 hardening indexes and zero uncovered foreign keys;
- all six catalog policies target `anon`, `authenticated`, and `lakeandpine_app`;
- restricted-role catalog visibility of 6 services, 5 add-ons, 4 plans, 7 service areas,
  6 FAQs, and 0 published reviews;
- a non-superuser, non-BYPASSRLS, NOINHERIT `lakeandpine_app` with no public-object
  ownership or public table grants; and
- public `/api/health` ready as `lakeandpine_app`, with the ten critical public routes at
  HTTP 200.

The remaining performance-advisor notices are informational: newly created indexes have
not yet accumulated production usage, and Auth currently uses a fixed connection limit.
Do not remove fresh operational indexes until real traffic and query telemetry justify it.
Keep `REQUEST_INTAKE_ENABLED`, `CLEANER_APPLICATIONS_ENABLED`, and `PAYMENTS_ENABLED`
false until their documented founder-owned gates are satisfied.

## Future migrations

Stop on any history mismatch. Do not replay the core/content migrations, paste the whole
migration folder into SQL Editor, or mark a migration applied without executing its exact
reviewed source. Apply future changes forward-only, record the provider-assigned version,
and align the repository filename without changing applied SQL bytes.
