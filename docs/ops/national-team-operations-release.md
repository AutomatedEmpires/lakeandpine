# National team operations release

## Release contents

Migrations `20260714045750` through `20260714045753` introduce the national
organization/team operating layer and its row-level authorization model. The web release
adds the seven team-operations surfaces and extends the cleaner portal. The final cutover
replaces broad application policies on `cleaning_teams` and `cleaner_time_off`, and installs
team-enforcement triggers on legacy `service_cases` and `job_assignments`; it also restricts
the legacy global operator pages to owner/general-manager access. All other schema changes
are additive.

## Preconditions

Before production application:

1. The pull request has independent review and all required checks are green.
2. Production migration history is exactly the four versions documented in
   `production-migration-20260713.md`.
3. The database runtime user remains `lakeandpine_app`, is not a superuser, does not
   bypass RLS, and owns no operational tables.
4. `REQUEST_INTAKE_ENABLED`, `CLEANER_APPLICATIONS_ENABLED`, and `PAYMENTS_ENABLED`
   remain false unless their separate founder-owned gates are complete.
5. A production staff customer exists for the owner bootstrap. Bootstrap is not exposed
   in preview mode and succeeds only once for the first active Lake & Pine owner.
6. Drain application traffic for the complete migration batch. The repository runner
   commits each migration atomically, and the two bounded legacy-table upgrades plus
   the final legacy trigger/policy replacement intentionally take short exclusive locks. A
   five-second lock timeout fails closed if traffic was not actually drained.
7. Confirm `cleaning_teams` has no more than 10,000 rows and `cleaner_time_off` has no
   more than 100,000 rows. Lock-adjacent bounded probes enforce those limits without a
   full-table count or a race with concurrent writes. Larger tables require a separately
   reviewed online migration; do not raise the embedded limits during cutover.

Stop on any unexpected migration-history row, changed migration checksum, existing
conflicting object, or loss of application-role restrictions.

## Verified local evidence

The fresh PostgreSQL 17 verifier applies all migrations as a hosted-compatible,
non-superuser `postgres` migration runner after superuser bootstrap. It proves:

- eight migrations apply in order (the four production baselines followed by the
  four national-operations migrations);
- every private operational table has row-level security;
- the application role is non-superuser, non-BYPASSRLS, and owns no public object;
- no foreign key lacks a covering index;
- owner bootstrap is one-time, identity-bound, and safe under concurrent claims;
- Team A's manager and cleaner cannot see Team B;
- complaints, recovery actions, and refund records are explicitly assigned to the
  booking's allocated team; the database rejects a second schedule for the same booking,
  preserving one booking → one service visit → one team owner;
- owners can grant an organization-wide GM, while a GM cannot grant another GM;
- a team manager can read and manage the local roster below manager level but cannot
  read Team B or grant manager access;
- cross-team actor, job-allocation, product, inventory, restock, and PTO writes are
  rejected;
- new stock must start at zero, stock identity and deletion are blocked, the immutable
  ledger reconciles on-hand, and negative stock is rejected;
- repeated low-stock usage creates one authorized open automatic-restock draft;
- direct restock lifecycle changes are rejected, and receiving an approved request
  creates the inventory receipt from the database-controlled transition;
- a cleaner or cleaner-backed shift lead can close a clock with nonzero breaks but
  cannot forge an estimate, source, approval, or initial submitted state;
- approved PTO removes the cleaner from the application-level recommendation shown to
  the owner and local manager;
- local managers and shift leads see only unallocated schedules in their team's active
  territory coverage and can allocate those schedules without national access; the
  verifier performs this with a staff-backed shift-lead operator;
- a Team A manager sees organization-wide bonus standards but cannot read Team B's
  team-specific bonus tiers;
- membership revocation waits for an already-authorized transaction and removes access
  from the next transaction;
- a manager cannot change their own compensation or bonus, while a local manager can
  approve another worker's submitted time and PTO;
- paid bonus insertion and other invalid initial award states are rejected;
- customer-review bonuses require the assigned cleaner, completed allocated work, the
  booking customer, and a configured tier; and
- the supported seed loads every team surface and the purge leaves zero synthetic rows
  across every table carrying `is_dev_seed`.

The application test suite covers role capabilities, team selection, reorder quantity,
actual time, labor variance, and team-attention scoring. The fresh verifier also exercises
authorization concurrency and the insertion/lifecycle paths that unit tests cannot cover.
Lint, TypeScript checking, the production Next.js build, and route smoke tests must also
pass in the release commit.

## Production sequence

1. Drain application traffic and keep it drained through the post-apply database checks.
2. Confirm repository and production migration history match.
3. Record the four canonical migration SHA-256 values from the reviewed commit.
4. Apply versions `20260714045750`, `20260714045751`, and `20260714045752`, in that
   order, through the authenticated Supabase migration path. Do not apply `20260714045753`
   yet; the legacy policies intentionally preserve the current application rollback point.
5. Confirm the provider recorded those three versions exactly once.
6. Deploy the reviewed application commit and, while traffic remains drained, check
   `/api/health`, critical public pages, `/operator/network`, every team surface,
   `/operator/recovery`, and `/crew` with authorized preview disabled.
7. Apply `20260714045753_national_legacy_rls_scope.sql`. This is the forward-only
   authorization cutover: the pre-national application is no longer a valid rollback target.
8. Confirm the provider recorded version `20260714045753` exactly once.
9. Run post-apply database checks for tables, policies, function search paths, indexes,
   grants, ownership, application role, and team-isolation probes.
10. Repeat `/api/health`, critical public pages, `/operator/network`, every team surface,
   `/operator/recovery`, and `/crew` with authorized preview disabled.
11. Restore traffic only after the database checks and both application health checks pass.
12. Bootstrap the first owner from the protected staff identity, then create the first
   operating team and assign local manager/cleaner memberships.
13. Add inventory products with verified supplier links and prices. Keep automatic
   reorder as approval-gated drafts until a purchasing provider is deliberately added.

## Forward-fix and recovery

Do not down-migrate or delete production operating records. Before version `20260714045753`,
the current application remains a valid rollback target and the new tables remain inert.
After `20260714045753`, keep traffic drained and do not roll the application back by itself:
ship a reviewed forward application/database repair. A reviewed emergency compatibility
migration may restore the prior policies only before owner bootstrap or any national-team
data is created. Never improvise a broad-policy rollback after operations begin.

If owner bootstrap was assigned to the wrong staff identity, stop. Do not edit the row
ad hoc. Require a reviewed authorization migration or protected administrative procedure
that records the transfer. If a team was created incorrectly but has no operational
history, mark it inactive rather than deleting it.

## Live-action boundaries

This release does not purchase supplies, execute payroll, pay bonuses, refund customers,
publish reviews, terminate workers, send messages, or enable public intake. Those actions
require provider configuration, approved policy, explicit authorization, and their own
production evidence.
