# Non-production premium operations proof

Verified on 2026-07-13 against a fresh, disposable PostgreSQL 17 database and local
Next.js production/development servers. The proof uses synthetic records only. It does
not send customer email, change DNS, call a payment provider, or move money.

## Reproduce

Create an empty local database whose name includes `ci`, `test`, `proof`, or
`disposable`, then run:

```bash
export MIGRATION_DATABASE_URL=postgresql://supabase_admin:<password>@127.0.0.1:5442/lakeandpine_proof

pnpm quality:verify-migrations
export DATABASE_URL=postgresql://postgres:lakeandpine-verifier-postgres@127.0.0.1:5442/lakeandpine_proof
pnpm ops:seed-content
pnpm ops:seed-dev
```

For the public runtime proof, start the web app with the same database plus private,
random 32-or-more-character values for `RUNTIME_SMOKE_TOKEN`,
`REQUEST_FINGERPRINT_SECRET`, and `BOOKING_REFERENCE_SECRET`. Then run in a second
shell:

```bash
export DATABASE_URL=postgresql://postgres:lakeandpine-verifier-postgres@127.0.0.1:5442/lakeandpine_proof
export RUNTIME_SMOKE_BASE_URL=http://127.0.0.1:3010
export RUNTIME_SMOKE_TOKEN='<same value configured on the server>'
pnpm ops:smoke-runtime
```

The runtime smoke marks every generated row as development data and deletes the request,
events, checklist, and notification-outbox rows in a `finally` block. Use
`pnpm ops:purge-dev-seed` to remove the broader private-workspace fixture.

## Captured evidence

- All four repository migrations applied in filename order with `ON_ERROR_STOP=1` on
  PostgreSQL 17. The premium operations migration SHA-256 was
  `1f94ab6067869a212e196dce0e66eccaae87d4fbf9eccf50eb6874ceb6a0c85e`
  for its canonical LF-normalized Git source. Production recorded the semantically
  identical mixed-line-ending payload as
  `a31fe0ec9e305fd1e8520ce5dc6f81847e1cbb965a953d89bc07fc2190672952`.
- The forward hardening migration set an immutable function search path, removed
  duplicate private application policies, scoped hosted public-read policies to the
  Supabase client roles, and added covering indexes for every production-advisor foreign
  key finding without changing application-role access. Its canonical LF-normalized
  SHA-256 was
  `54c734dde9cb534d4f21b38cf5da754b09e255fb2d1c7f3f1ce891d473c2ee92`.
- The verifier proved `lakeandpine_app` is a non-superuser, cannot bypass RLS, owns no
  operational tables, and has only the intended table privileges. A second physical
  Postgres.js connection opened as `postgres` and reported `current_user =
  lakeandpine_app` through the same startup-role mechanism used by the web runtime.
- Database integration probes rejected malformed or ineligible ZIPs, active territories
  without screened capacity, unlinked booking-mutating cases, undersized labor windows,
  booking-only schedule claims,
  overstaffing, assignments outside recurring availability, daily/weekly/job-count cap
  violations, time-off approval over accepted work, capacity-invalid reschedules,
  unfinished recovery claims, and over-refunds. Confirmed/completed schedules synchronized
  booking state, cancellations remained possible after capacity paused, and completed
  recovery/refund receipts resolved their linked service cases.
- Premium requests persist one booking, one immutable request event, a program-specific
  checklist, two durable notification-outbox records, consent/version evidence,
  qualification state, crew/skill requirements, duration, and an HMAC-derived public
  reference. An idempotent retry returns the same request.
- The construction smoke planned four cleaners, 1,260 labor minutes, a walkthrough
  qualification path, four checklist rows, and no public or persisted fixed price.
- Ten public routes returned HTTP 200 from the optimized runtime, including the premium
  home, programs, services, pricing/proposal, areas, consultation, support, privacy, and
  cleaner-application surfaces.
- Seed and purge commands proved synthetic territory, cleaner, application, premium
  request, schedule, service case, recovery/refund-review, and customer records can be
  created and removed without touching non-development rows.
- Browser QA covered desktop and 375px mobile layouts. The public request flow advanced
  through program selection and surfaced accessible validation. Home, audience,
  service-support, cleaner-application, customer, cleaner, and operator pages had no
  horizontal overflow. Labels, headings, skip navigation, mobile navigation, privacy
  choices, and validation alerts were exposed in the accessibility tree.
- The private operator page displayed capacity-backed territories, applicant screening,
  cleaner readiness/availability, qualification, timezone-aware crew suggestions,
  exact-capacity schedule lifecycle with pre-confirmation crew removal, private case
  contact/outcome handling, owned/dated recovery actions, and a non-money-moving refund
  ledger.
- The cleaner workspace displayed scoped skills, territory timezone, capacity, recurring
  availability, assignments, and DST-safe time-away controls. The customer workspace
  distinguished preferences from confirmed windows and routed reschedules, cancellations,
  complaints, recleans, refund reviews, damage concerns, and general support into visible,
  reference-backed operator cases.

## Readiness classification

| Surface | Status | Remaining gate |
| --- | --- | --- |
| Premium public market site | Runtime and responsive proof complete | Founder-owned contact channels still need purchase and configuration. |
| Consultation request | End-to-end local proof complete | Keep production intake disabled until email delivery/monitoring and initial capacity are verified. |
| Intelligent scheduling | Domain, database guards, and operator workflow complete | Human qualification, real cleaner availability, and territory activation are required for each confirmation. |
| Cleaner application/workspace | Preview proof complete | Production auth and real screening/onboarding process must be configured before activation. |
| Customer dashboard | Preview proof complete | Production Clerk identity/webhook proof is still required for customer access. |
| Service recovery | Workflow proof complete | Operator ownership and contact routing must be assigned before accepting public cases. |
| Refund ledger | Decision/audit surface only | Live refunds remain a founder hard stop; an operator must execute externally and record the provider reference. |
| Email | Durable outbox and retry path complete | Purchased domain/inbox, authenticated sender, recipient ownership, and delivery proof are outstanding. |
| Payments | Intentionally inactive | No checkout, charge, capture, or provider refund is enabled. |

This proof establishes that the code and database can run the premium operating model. It
does not convert human qualification, authenticated communications, live capacity, or
money movement into automated promises.
