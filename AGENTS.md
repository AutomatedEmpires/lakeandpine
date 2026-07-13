# Lake & Pine — Venture Operating Contract

This contract is binding for every human and automated contributor. Lake & Pine should deliver a trustworthy premium property-care experience, and add platform complexity only when it improves scope quality, crew readiness, scheduling, or service recovery.

## Operating doctrine

Agents are expected to ship meaningful Lake & Pine improvements, not produce endless audits. Prefer tested, reviewable changes that can merge over reports that merely describe work. Use protected previews, synthetic or clearly marked dev data, reversible branches, and established test resources aggressively. Stop only for destructive, paid, live-money, legal, DNS, credential, ownership, MFA, or public-launch actions listed below.

The operating default is **execute, verify, document, and open a PR**. Lack of real customers is a reason to iterate quickly; it is not permission to invent reviews, qualifications, service coverage, or business facts.

## Venture thesis

Lake & Pine can win as a premium interior-care operator for private estates, construction handoffs, lake and marine interiors, and carefully selected professional spaces. The differentiator is disciplined scoping, finish awareness, qualified crews, capacity-backed scheduling, accountable closeout, and responsive service recovery. The website is a consultation and operating surface for evidenced Inland Northwest service corridors—not a rapid-turnover/Airbnb service, a mass-market maid marketplace, or generic home-services SaaS.

The shortest useful journey is:

```text
property decision-maker -> trust -> property brief -> qualification -> capacity-backed plan -> custom proposal/confirmation -> service -> closeout/recovery
```

## Primary user and buyer

- **Primary user/buyer:** an estate owner or manager, construction owner/representative, general contractor, vessel owner or marina decision-maker, or select commercial/property leader within an evidenced service corridor who values careful execution over commodity speed.
- **Secondary users:** a Lake & Pine operator who needs qualified requests, accurate property context, defensible crew and territory capacity, auditable scheduling, and service recovery; and a screened cleaner who needs clear assignments, availability, and time-off controls.
- **Deprioritized segment:** Airbnb and other high-churn short-term-rental turnovers where speed and unit volume dominate finish-aware, relationship-based property care.
- **Not the target:** vendors seeking a marketplace, anonymous software users, or visitors who need an account before they can understand or contact the business.

## What the product must become

Build a fast, local, credible public site that:

- explains the four real service programs, scope boundaries, custom-proposal process, and service-corridor review;
- routes visitors to a low-friction consultation request without pretending to offer an instant appointment or public price;
- captures enough property, finish, access, timing, and outcome context to qualify a request without collecting access codes or other unnecessary sensitive data;
- supports cleaner onboarding, capability records, recurring availability, time off, territory fit, crew proposals, scheduling, booking changes, complaints, recleans, cancellations, and refund decisions as accountable operating surfaces;
- confirms service only after qualification, realistic duration, travel, required skills, crew acceptance, and daily/weekly capacity checks;
- preserves a clear operator-visible fallback when scheduling, email, auth, or payment providers are absent.

Authentication and online payment are optional capabilities, not measures of product maturity. A credible consultation, manual proposal, and operator-confirmed service path may precede live payment.

## Current stage

As of 2026-07-13, the portfolio has **zero confirmed real Lake & Pine customers/users**. The repository contains a public Next.js app, premium property-request flow, customer and cleaner workspaces, a private operations console, capacity-aware scheduling foundations, service-case/refund decision workflows, Pine Concierge, service-corridor pages, provider-gated integrations, and recovered product/design evidence. Legacy public starting-price and rapid-turnover positioning is retired; do not restore it.

This is a pre-customer premium-operations launch stage. The right goal is to prove the full consultation, qualification, crew, scheduling, service, closeout, and recovery journey—not to defend today's implementation as if it were a mature production system. Refresh repository and PR facts before relying on this snapshot.

## Execution authority — act without founder approval

Within a scoped branch, agents may independently:

- fix bugs, security findings, accessibility issues, responsive behavior, broken links, metadata, structured data, and service-corridor search defects;
- improve public copy, information architecture, calls to action, consultation clarity, contact routing, service-program/area pages, and honest trust content;
- add or improve tests, fixtures, validation scripts, runbooks, CI, dependency patches, and observability code that remains inactive without keys;
- refactor app-local code while preserving behavior and the product/design evidence;
- create static assets and source-backed service content;
- use synthetic, seed, demo, or test data in local, isolated, or protected-preview lanes;
- create and test non-destructive database migrations in local/dev/preview databases;
- exercise sandbox/test-mode payments and non-customer internal email paths with venture-scoped test recipients;
- create protected preview deployments using already-configured, non-billing resources and existing safe credentials;
- remove unsupported claims, dead complexity, or unnecessary auth/payment gates;
- open or update a reviewable PR and respond to review/CI feedback.

These actions do not require a founder checkpoint merely because they touch the booking journey or public UI. Keep them reversible, avoid live data and real sends/charges, and record evidence in the PR.

## True hard stops — founder approval required

Stop before any of the following:

- upgrading a paid provider plan or accepting a new recurring cost;
- buying a domain or performing a DNS/domain cutover;
- activating live money, creating a real charge/subscription, capturing/refunding funds, or enabling production Checkout;
- destructively deleting a provider project, database, storage bucket, environment, deployment history, or other provider resource;
- running a destructive production-database migration or destructive cleanup against live state;
- revoking or rotating credentials, secrets, signing keys, recovery codes, or tokens;
- transferring repository, provider, domain, or account ownership;
- making a public launch announcement or representing the business as launched without approval;
- buying ads, starting campaigns, or sending marketing broadcasts;
- filing legal documents for the founder, the venture, or any other entity;
- completing an action that requires MFA when the founder is unavailable.

A hard stop blocks only the gated action. Prepare code, migration plans, screenshots, checklists, rollback steps, and preview evidence so the founder can make a narrow decision.

## High-value work to prioritize

1. Make the mobile and desktop path from program discovery to a complete property brief unmistakable.
2. Preserve the distinction between a consultation request, an operator-qualified scope, a custom proposal, and a confirmed schedule; never imply instant booking or a public fixed price.
3. Prove qualification, territory fit, realistic labor duration, required capabilities, crew acceptance, travel buffers, and daily/weekly capacity before schedule confirmation.
4. Make request capture resilient: validation, duplicate prevention, error states, consent, delivery fallback, and operator-visible handoff.
5. Give cleaners clear, private assignment, availability, profile, and time-off surfaces; do not treat an application or proposed assignment as verified or accepted.
6. Make reschedules, cancellations, complaints, recleans, damage reports, recovery actions, and refund decisions auditable without automatically moving money.
7. Build accurate, differentiated program and service-corridor pages for estate, construction, marine, and select-commercial intent.
8. Prove the complete guest and operating journey without requiring Clerk, Stripe, PostHog, or Mapbox for public understanding or request capture.
9. Improve page speed, semantic HTML, keyboard/screen-reader behavior, and honest structured data.
10. Keep operations legible enough that one accountable operator can understand and run them without bypassing hard capacity or qualification gates.

## Low-value work to avoid

- Reintroducing Airbnb/rapid-turnover positioning, commodity maid-service language, public starting prices, or instant-slot promises.
- Building a marketplace, vendor network, multi-tenant platform, or generic admin suite before the service business needs one.
- Forcing sign-in, payment, dashboards, chat, or AI into a consultation journey that works better with a property brief and clear operator-review expectation.
- Chasing optional provider completeness instead of a working public journey.
- Writing generic luxury copy, duplicated city pages, fake urgency, fake reviews, or SEO pages with no program or corridor value.
- Replacing a scoped implementation with another readiness audit or speculative roadmap.
- Replatforming or redesigning the entire site while solving a focused issue.

## Provider boundaries

Current integration surfaces include Vercel, Supabase/Postgres, Doppler/secrets, Clerk, Stripe, Resend/email, PostHog, Sentry, and Mapbox.

Agents may use existing local, test, sandbox, or protected-preview lanes when the task requires them. They may adjust repository configuration and preview-safe integration code, but must not expose secret values or borrow another venture's account, sender, project, or data.

Assigned agents may make reversible, non-billing provider configuration changes in established dev, preview, or production lanes when scope, least privilege, rollback, and verification are explicit. Stop only when the action crosses a listed hard stop: paid plan, live money, domain/DNS, destructive deletion, destructive production migration, credential rotation/revocation, ownership transfer, public launch/campaign, legal filing, or unavailable MFA. Preparing exact dashboard steps and validation is always allowed.

Missing optional keys must preserve honest fallbacks. Do not provision a provider merely to make a preview look complete.

## Data, money, email, auth, and legal boundaries

### Data

- Keep Postgres access server-side and preserve authorization/RLS boundaries.
- Derive labor direction, crew size, qualification gates, and any proposal-sensitive values on the server; never trust browser planning totals or schedule eligibility as authoritative.
- Use synthetic or clearly marked dev records in tests and previews. Do not use live names, addresses, contact details, booking notes, or payment data.
- Local/dev/preview migrations must be non-destructive, idempotent where practical, and paired with rollback or forward-fix notes. Destructive production work is a hard stop.

### Money

- Preserve “custom proposal after scope review.” Do not publish a starting price, present a planning direction as a quote, or present a request as a confirmed appointment.
- Stripe sandbox/test mode and inactive product/price/Checkout configuration are available for development. Stop before configuration can create a real charge/subscription/capture/refund or otherwise activates live money.
- A manual proposal, confirmation, invoice, and externally executed refund path is a valid launch strategy.

### Email and contact routing

- Internal delivery tests may use controlled, consenting, team-owned venture test recipients and non-customer data. Assigned reversible transactional-email configuration may proceed with test/non-customer recipients; DNS activation, a public/marketing campaign, or a real-customer launch remains a hard stop where applicable.
- Email failure must not erase a submitted lead; retain an operator-visible recovery path without logging private contact data.

### Auth

- Public marketing, consultation requests, contact, and service support should work without Clerk unless an account is essential to the feature.
- Local identities are not production identities. Assigned reversible auth configuration may proceed with least privilege, rollback, synthetic identities, and unauthorized-path tests; do not rotate credentials or transfer ownership.

### Claims and privacy

- Never fabricate reviews, customer counts, prices, availability, team size, partnerships, service coverage, insurance, licensing, background checks, certifications, or product claims.
- Unsupported claims should be removed or replaced with explicit placeholders before public release, not defended as “prototype copy.”
- Collect the minimum contact/home information needed for the requested service and never expose it in logs, screenshots, fixtures, PRs, or agent output.

## Design notes

The recovered prototype and product-recovery documents are evidence for the intended direction. Preserve the premium pine/lake/cream palette, editorial serif display style, rounded/glass surfaces, local landscape tone, strong mobile navigation, sticky mobile CTA, and calm, accessible behavior unless a scoped design task says otherwise.

The public experience should feel like a discreet, dependable premium property-care service, not a SaaS dashboard, generic marketplace, or rushed turnover company. Private operator and cleaner surfaces should favor legibility and accountability over decorative luxury. Design improvements are welcome; incidental full redesigns and unsupported visual claims are not.

## Branch and multi-agent coordination

- For new work, start from current `main`. When explicitly assigned an existing PR/branch, continue there after checking ownership and synchronizing its base as needed. Never push directly to `main`.
- Agent branches: `agent/<scope>-<short-description>`.
- Other branches: `feat/<short-description>`, `fix/<short-description>`, `docs/<short-description>`, or `chore/<short-description>`, in kebab-case.
- Before editing, run `git status -sb`, record branch/HEAD, inspect open PRs/issues, and identify overlapping files. Coordinate rather than overwriting another branch's work.
- Keep one coherent outcome per branch. Rebase or merge current `main` only when needed and never rewrite shared history without coordination.
- Implementers do not merge their own PRs. A designated maintainer or approved automation may merge after independent review and green required checks; do not delete unmerged branches.

## Testing and PR requirements

Use the pinned Node/pnpm toolchain and repository scripts:

```text
pnpm install --frozen-lockfile
pnpm test
pnpm lint
pnpm typecheck
pnpm build
git diff --check
```

Run focused tests during iteration, then the full relevant sequence before requesting review. UI changes require screenshots at relevant mobile/desktop widths and an accessibility pass. Property-request, qualification, scheduling, authorization, recovery, refund-ledger, or rendering changes require focused regression coverage.

For Markdown-only work, `git diff --check` plus a focused content/link review is sufficient; state why app checks were skipped. `ops:seed-content`, `ops:seed-dev`, and `ops:purge-dev-seed` are operations commands, not routine validation. Never aim them at live state to make CI pass.

PRs must explain the user/operating outcome, scope, evidence, provider/data impact, and any remaining hard stop. Keep the diff small enough to review and do not mix provider activation or launch operations into ordinary product work.

## Definition of done

Work is done when:

- the intended visitor, cleaner, customer, or operator outcome works end to end, including empty/error/fallback states;
- behavior is covered by focused tests and the required relevant checks pass;
- mobile, desktop, accessibility, and honest-copy implications were reviewed when applicable;
- no unsupported business claim, secret, private data, real charge, or real send was introduced;
- preview/demo data is clearly non-customer data and cleanup is documented;
- docs/runbooks describe any new operating step;
- the PR is scoped, independently reviewable, current with overlapping work, and includes rollback or forward-fix notes where risk warrants them.

An audit, code draft, passing unit test, or provider-hosted URL alone is not done.

## What not to overprotect at zero users

There are no real Lake & Pine users/customers to migrate or preserve. Do not use hypothetical “customer impact” to block reversible improvements, delete dead prototype-only code, or defend awkward pre-launch flows. Route and component structure, seed data, copy hierarchy, form steps, local schemas, and preview UX may change when tests and the product thesis support the change.

Still protect secrets, provider ownership, public claims, prospective lead privacy, source evidence, and live-money/legal boundaries. Zero users lowers migration cost; it does not lower integrity.

## Current known PRs and blockers

Refreshed 2026-07-13 UTC:

- Draft PR #7, `feat: complete Lake & Pine premium operations launch surfaces`, is the active integrated launch branch. Refresh its review and check state before changing overlapping files.
- Draft PRs #4, #5, and #6 are superseded integration attempts; do not treat them as the current release candidate.
- PR #3, `test: prove disposable booking runtime`, has merged into `main` and remains historical runtime-proof context.

Before opening public intake or cleaner applications, verify the owned phone/inbox and reply path, monitoring, runtime database role, migration state, real territory/crew capacity, privacy/legal copy, and required provider keys. Keep public intake flags disabled until those dependencies are evidenced. Optional live payment, analytics, and maps are blockers only for features that truly need them—not for a strong premium consultation and operations surface.

## Output format for future agents

Every final handoff must report:

1. branch, HEAD, task/acceptance criteria, and product sources used;
2. exact files and behavior changed;
3. checks run with pass/fail/skipped results and UI/accessibility evidence when relevant;
4. provider, deployment, DNS, data, money, email, auth, and legal impact—state `none` explicitly where applicable;
5. the visitor/operator outcome shipped, not a generic “customer impact” statement;
6. assumptions, remaining blockers, rollback/forward-fix notes, and any true hard stop requiring founder action; and
7. PR URL and state, or a statement that no PR was created.
