# Production migration release — 2026-07-13

This release reconciles the repository migration versions with the Lake & Pine Supabase
project before adding the premium operations schema.

## Expected production history

The project must report exactly these already-applied migrations before release:

- `20260707042452 core`
- `20260707042519 content_seed`

The repository uses those same versioned filenames. Do not use a checkout that still
contains `0001_core.sql` or `0002_content_seed.sql`; those retired names create false
history drift even though the schema already exists.

## Approved production change

Apply exactly `20260713053255_service_planning_foundation.sql` after the release commit
passes the fresh PostgreSQL 17 verifier. The operation is additive and contains the
premium booking, territory, cleaner, availability, scheduling, service-case, refund,
outbox, RLS, and application-role foundation. The reviewed SHA-256 is
`a31fe0ec9e305fd1e8520ce5dc6f81847e1cbb965a953d89bc07fc2190672952`.

Before applying it:

1. confirm the two history rows above and confirm the new version is absent;
2. compare the exact SHA-256 reported by `pnpm quality:verify-migrations` with the release
   record in the PR;
3. run a production backup/readiness check;
4. keep `REQUEST_INTAKE_ENABLED`, `CLEANER_APPLICATIONS_ENABLED`, and `PAYMENTS_ENABLED`
   false;
5. apply only the new version through the authenticated Supabase migration API;
6. confirm the migration history contains the third version once, then run the security
   advisor and `/api/health` role/schema proof.

Stop on any history mismatch. Do not replay the core/content migrations, paste the whole
migration folder into SQL Editor, or mark a migration applied without executing its exact
reviewed source.
