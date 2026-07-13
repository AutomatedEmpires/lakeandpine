# Lake & Pine — Agent Operating Standards

This file is binding for every human or automated contributor. Lake & Pine is intentionally simpler than the portfolio marketplaces: protect the public service journey and do not add platform complexity without a real customer need.

## 1. App purpose

Lake & Pine is a premium local home-cleaning/service business and public conversion site for Coeur d'Alene, Spokane, and nearby Inland Northwest markets. The product helps a visitor understand services, trust the business, receive an honest estimate, book when appropriate, and return for repeat service.

It is a single Next.js application. Public marketing, local-SEO area pages, trust content, the estimate flow, booking flow, and customer follow-up are its relevant surfaces; it is not required to behave like a multi-sided marketplace.

## 2. Business vision

Make a local service business feel dependable, premium, easy to understand, and easy to contact. Capture qualified leads and bookings with clear expectations rather than artificial product gates. The public marketing/service site can move faster than provider-heavy portfolio apps.

Do not force authentication or payment into public marketing, estimate, lead, or guest-booking flows unless the requested feature genuinely requires an account or online payment. Prefer an honest manual/invoice fallback to a brittle integration.

## 3. Current rollout status

Snapshot 2026-07-12: **blocked · security-risk · design-needed** for a fully evidenced rollout. A public app and data foundation exist, but a provider-hosted build is not proof of functional rollback, DNS, data, telemetry, support, or payment readiness. Portfolio evidence also records a high-priority DOM-XSS concern and insufficient broad automated coverage for a rollout claim.

This status does not stop low-risk public copy, SEO, accessibility, or service-marketing improvements. Optional Clerk, Stripe, Resend, PostHog, Sentry, and Mapbox activation must not become prerequisites for ordinary public-site work. Refresh current evidence before relying on this snapshot.

## 4. Branch naming rules

- Branch from current `main`; never push directly to `main`.
- Agent work: `agent/<scope>-<short-description>`.
- Other work: `feat/<short-description>`, `fix/<short-description>`, `docs/<short-description>`, or `chore/<short-description>`, in kebab-case.
- Before editing, record `git status -sb`, branch and HEAD, inspect open PRs/issues, and confirm file ownership. One task, branch, owner, and coherent artifact set at a time.
- Open a scoped PR against `main`; the builder is not the approver. Do not merge, force-push, rewrite history, delete branches, or overwrite another agent's work.

## 5. Required checks before PR

Use the pinned Node/pnpm versions and the exact CI sequence:

```text
pnpm install --frozen-lockfile
pnpm test
pnpm lint
pnpm typecheck
pnpm build
git diff --check
```

For docs-only work, `git diff --check` and focused Markdown/link review are the minimum; report why app checks were skipped. Never use `ops:seed-content`, `ops:seed-dev`, or `ops:purge-dev-seed` as routine validation. Add focused tests for non-trivial pricing, quote, booking, authorization, or rendering logic.

## 6. Forbidden actions

- Do not deploy, promote, change domains/DNS, mutate providers, edit secrets, or touch billing/RBAC/recovery settings.
- Do not run production SQL, migrations, seed/purge/reset commands, or destructive cleanup.
- Do not create Stripe products/prices, take charges, issue refunds, activate Checkout, send real email, or change production auth without explicit approval.
- Do not force auth/payment onto a public flow merely for architectural consistency.
- Do not fabricate reviews, customer counts, service coverage, availability, credentials, trust marks, prices, partnerships, or local claims.
- Do not remove or rewrite the recovered prototype/design evidence, redesign the app incidentally, or replace honest starting estimates with guaranteed final quotes.
- Do not expose customer contact, address, booking, quote, payment, or authentication data in logs, fixtures, screenshots, issues, or agent output.

## 7. Provider no-touch zones

Production Supabase/Postgres, Vercel, Doppler/secrets, Clerk, Stripe, Resend and email/DNS, PostHog, Sentry, Mapbox, and any registrar/domain surface are read-only unless a task includes explicit owner approval. No dashboard/CLI/API writes, deployment changes, environment sync, webhook registration, sender activation, data mutation, or billing changes.

Key-gated fallbacks are intentional. Do not “fix” an absent optional provider by provisioning or borrowing another venture's account.

## 8. Data, money, email, and auth guardrails

### Data

- Postgres access stays server-side. RLS/public-read boundaries and transactional-table restrictions must remain intact.
- Quotes and estimates are recalculated server-side. Use synthetic/local fixtures; no live customer records in tests or outputs.
- Production seed/purge/migrations and direct SQL require a named data owner, backup/rollback plan, and approved window.

### Money

- Preserve “starting estimate; final quote confirmed before visit.” Never present an estimate as a guaranteed final price.
- Stripe is optional. Do not create live products/prices, charge, capture, refund, or activate payment flows without explicit payment/legal approval.
- An invoice-after-service/manual fallback is acceptable and preferable to unsafe online payment activation.

### Email

- Resend is optional and venture-scoped. Do not activate domains/senders or send real messages.
- Email failure must not lose a booking. Report skipped or failed delivery honestly and protect customer contact data.

### Auth

- Clerk is optional for public marketing, estimate, lead, and guest-booking journeys. Require auth only for features that truly need an account.
- Local preview identities are never production identities. Keep webhook verification fail-closed and do not change production Clerk without approval.

## 9. Design notes

The recovered prototype and product recovery docs are evidence for the intended visual direction; preserve them. Retain the premium pine/lake/cream palette, editorial serif display style, rounded/glass surfaces, local landscape tone, clear mobile navigation, sticky mobile CTA, and accessible responsive behavior.

The journey should remain direct: trust → estimate → book/contact → repeat service. Keep local SEO accurate and useful. Avoid generic SaaS dashboards, marketplace conventions, dark patterns, invented urgency, incidental redesign, or unnecessary authentication/payment gates.

## 10. Current known PRs and blockers

Snapshot 2026-07-12: no open PRs were found. Refresh before starting work.

Known blockers for a full rollout claim include the DOM-XSS finding, limited rollout-grade test evidence, unresolved product scope (marketing/lead service versus more complex booking product), functional rollback/DNS/data/telemetry/support proof, and provider activation decisions. Optional integrations are gates for the features that use them, not blockers for safe public marketing/service improvements.

## 11. Output format for future agents

Report:

1. branch, HEAD, issue/acceptance criteria, and source documents used;
2. scope and exact files changed;
3. checks and exact results, including skips with reasons;
4. data/provider/deployment/DNS/money/email/auth impact—normally `none`;
5. screenshots at relevant mobile/desktop widths and accessibility notes for UI changes;
6. customer-journey impact, assumptions, remaining blockers, and approvals required; and
7. PR URL/state or a statement that no PR was created.
