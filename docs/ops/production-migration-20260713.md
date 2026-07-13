# Production migration release — 2026-07-13

This release reconciles the repository migration versions with the Lake & Pine Supabase
project before adding the premium operations schema.

## Current production history

The project reported exactly these applied migrations after the premium operations
release:

- `20260707042452 core`
- `20260707042519 content_seed`
- `20260713233006 service_planning_foundation`

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

## Forward hardening change

Apply exactly `20260713234000_production_schema_hardening.sql` after its release commit
passes the fresh PostgreSQL 17 verifier. It sets an explicit function search path,
removes redundant private-table policies, narrows public catalog policies to Supabase's
`anon` and `authenticated` roles, and adds covering indexes for every foreign key
reported by the production performance advisor. Its canonical LF-normalized SHA-256 is
`54c734dde9cb534d4f21b38cf5da754b09e255fb2d1c7f3f1ce891d473c2ee92`.

Before applying the forward hardening migration:

1. confirm the three history rows above and confirm the new migration is absent;
2. compare the exact SHA-256 reported by `pnpm quality:verify-migrations` with the release
   record in the PR;
3. run a production backup/readiness check;
4. keep `REQUEST_INTAKE_ENABLED`, `CLEANER_APPLICATIONS_ENABLED`, and `PAYMENTS_ENABLED`
   false;
5. apply only the new version through the authenticated Supabase migration API;
6. record the provider-assigned migration version, align the repository filename in a
   no-content-change follow-up, and confirm the migration history contains the new
   version once;
7. rerun the security and performance advisors plus the `/api/health` role/schema proof.

Stop on any history mismatch. Do not replay the core/content migrations, paste the whole
migration folder into SQL Editor, or mark a migration applied without executing its exact
reviewed source.
