# Lake & Pine — Venture Operating Contract

This contract is binding for every human and automated contributor. Lake & Pine should move faster than the portfolio marketplaces: ship a trustworthy local-service experience, and add platform complexity only when it improves the service journey.

## Operating doctrine

Agents are expected to ship meaningful Lake & Pine improvements, not produce endless audits. Prefer tested, reviewable changes that can merge over reports that merely describe work. Use protected previews, synthetic or clearly marked dev data, reversible branches, and established test resources aggressively. Stop only for destructive, paid, live-money, legal, DNS, credential, ownership, MFA, or public-launch actions listed below.

The operating default is **execute, verify, document, and open a PR**. Lack of real customers is a reason to iterate quickly; it is not permission to invent reviews, qualifications, service coverage, or business facts.

## Venture thesis

Lake & Pine can win as a premium local home-cleaning and service brand by making trust, pricing expectations, and contact simpler than the local alternatives. The website is a conversion and operating surface for Coeur d'Alene, Spokane, and nearby Inland Northwest markets—not a venture marketplace and not generic home-services SaaS.

The shortest useful journey is:

```text
local visitor -> trust -> estimate -> contact/book -> confirmed service -> repeat relationship
```

## Primary user and buyer

- **Primary user/buyer:** a homeowner, vacation-rental operator, or small-office decision-maker within an evidenced service area who wants a reliable cleaning service.
- **Secondary user:** a Lake & Pine operator who needs qualified leads, accurate job context, manageable scheduling, and clean follow-up.
- **Not the target:** vendors seeking a marketplace, anonymous software users, or visitors who need an account before they can understand or contact the business.

## What the product must become

Build a fast, local, credible public site that:

- explains real service types, scope, starting estimates, and service areas;
- routes visitors to a low-friction estimate, contact, or booking outcome;
- supports honest local SEO pages with distinct, useful area content;
- captures enough context to qualify and respond to a lead without oversharing;
- preserves a clear manual fallback when scheduling, email, auth, or payment providers are absent;
- can grow into scheduling, customer follow-up, and repeat-service tools only as operations justify them.

Authentication and online payment are optional capabilities, not measures of product maturity. A good marketing and lead-capture release may precede both.

## Current stage

As of 2026-07-12, the portfolio has **zero real Lake & Pine customers/users**. The repository contains a public Next.js app, estimate logic, persisted booking flow, customer-dashboard concepts, Pine Concierge, local-service pages, provider-gated integrations, and recovered product/design evidence. A disposable booking runtime proof merged in PR #3 after this standards branch diverged from `main`.

This is a pre-customer validation and marketing-launch stage. The right goal is to prove the full public journey and operating handoff—not to defend today's implementation as if it were a mature production system. Refresh repository and PR facts before relying on this snapshot.

## Execution authority — act without founder approval

Within a scoped branch, agents may independently:

- fix bugs, security findings, accessibility issues, responsive behavior, broken links, metadata, structured data, and local SEO defects;
- improve public copy, information architecture, calls to action, estimate clarity, contact routing, service-area pages, and honest trust content;
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
- filing legal documents or accepting legal terms on the founder's behalf;
- completing an action that requires MFA when the founder is unavailable.

A hard stop blocks only the gated action. Prepare code, migration plans, screenshots, checklists, rollback steps, and preview evidence so the founder can make a narrow decision.

## High-value work to prioritize

1. Make the mobile and desktop path from landing page to estimate/contact unmistakable.
2. Validate estimate inputs and preserve the distinction between a starting estimate and a confirmed quote.
3. Build accurate, differentiated service and service-area pages for local search intent.
4. Make lead capture resilient: validation, duplicate prevention, error states, consent, delivery fallback, and operator-visible handoff.
5. Prove the complete guest journey without requiring Clerk, Stripe, PostHog, or Mapbox.
6. Improve page speed, semantic HTML, keyboard/screen-reader behavior, and local-business structured data.
7. Replace placeholder reviews or unsupported claims with honest empty states or sourced facts before public launch.
8. Keep operations simple enough that one local operator can understand and run them.

## Low-value work to avoid

- Building a marketplace, vendor network, multi-tenant platform, or generic admin suite before the service business needs one.
- Forcing sign-in, payment, dashboards, chat, or AI into a journey that works better with a form and clear callback expectation.
- Chasing optional provider completeness instead of a working public journey.
- Writing generic lifestyle copy, duplicated city pages, fake urgency, fake reviews, or SEO pages with no local value.
- Replacing a scoped implementation with another readiness audit or speculative roadmap.
- Replatforming or redesigning the entire site while solving a focused issue.

## Provider boundaries

Current integration surfaces include Vercel, Supabase/Postgres, Doppler/secrets, Clerk, Stripe, Resend/email, PostHog, Sentry, and Mapbox.

Agents may use existing local, test, sandbox, or protected-preview lanes when the task requires them. They may adjust repository configuration and preview-safe integration code, but must not expose secret values or borrow another venture's account, sender, project, or data.

Production provider settings are not a casual coding surface. Do not change production domains/DNS, billing, RBAC, recovery settings, live webhooks, live senders, production auth policy, live payment state, or provider ownership without the applicable hard-stop approval. Preparing a change and documenting exact dashboard steps is allowed; silently performing it is not.

Missing optional keys must preserve honest fallbacks. Do not provision a provider merely to make a preview look complete.

## Data, money, email, auth, and legal boundaries

### Data

- Keep Postgres access server-side and preserve authorization/RLS boundaries.
- Recalculate price and quote-sensitive values on the server; never trust browser totals as authoritative.
- Use synthetic or clearly marked dev records in tests and previews. Do not use live names, addresses, contact details, booking notes, or payment data.
- Local/dev/preview migrations must be non-destructive, idempotent where practical, and paired with rollback or forward-fix notes. Destructive production work is a hard stop.

### Money

- Preserve “starting estimate; final quote confirmed before service.” Do not present an estimate as a guaranteed final price.
- Stripe sandbox/test mode is available for development. Real products, prices, subscriptions, captures, refunds, and production Checkout are hard stops.
- A manual estimate, confirmation, or invoice path is a valid launch strategy.

### Email and contact routing

- Internal delivery tests may use approved venture-scoped test recipients and non-customer data.
- Do not activate a sender/domain or send real customer/marketing email without the appropriate launch approval.
- Email failure must not erase a submitted lead; retain an operator-visible recovery path without logging private contact data.

### Auth

- Public marketing, estimates, contact, and guest booking should work without Clerk unless an account is essential to the feature.
- Local identities are not production identities. Keep admin/customer boundaries fail-closed and test unauthorized paths.

### Claims and privacy

- Never fabricate reviews, customer counts, prices, availability, team size, partnerships, service coverage, insurance, licensing, background checks, certifications, or product claims.
- Unsupported claims should be removed or replaced with explicit placeholders before public release, not defended as “prototype copy.”
- Collect the minimum contact/home information needed for the requested service and never expose it in logs, screenshots, fixtures, PRs, or agent output.

## Design notes

The recovered prototype and product-recovery documents are evidence for the intended direction. Preserve the premium pine/lake/cream palette, editorial serif display style, rounded/glass surfaces, local landscape tone, strong mobile navigation, sticky mobile CTA, and calm, accessible behavior unless a scoped design task says otherwise.

The experience should feel like a dependable local service, not a SaaS dashboard or generic marketplace. Design improvements are welcome; incidental full redesigns and unsupported visual claims are not.

## Branch and multi-agent coordination

- Start from current `main`; never push directly to `main`.
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

Run focused tests during iteration, then the full relevant sequence before requesting review. UI changes require screenshots at relevant mobile/desktop widths and an accessibility pass. Quote, booking, authorization, or rendering changes require focused regression coverage.

For Markdown-only work, `git diff --check` plus a focused content/link review is sufficient; state why app checks were skipped. `ops:seed-content`, `ops:seed-dev`, and `ops:purge-dev-seed` are operations commands, not routine validation. Never aim them at live state to make CI pass.

PRs must explain the user/operating outcome, scope, evidence, provider/data impact, and any remaining hard stop. Keep the diff small enough to review and do not mix provider activation or launch operations into ordinary product work.

## Definition of done

Work is done when:

- the intended visitor or operator outcome works end to end, including empty/error/fallback states;
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

- Draft PR #4, `docs: add agent operating standards`, is this contract branch.
- PR #3, `test: prove disposable booking runtime`, has merged into `main`; this branch is one commit behind it. Refresh before changing booking/runtime/data files.
- No other open PRs were reported at refresh.

Before a public marketing launch, resolve or explicitly disposition unsupported service claims, contact-routing ownership, real service areas/availability, privacy/legal copy, and any required runtime/provider keys. Optional auth/payment/analytics/maps are blockers only for features that truly need them—not for a strong public service and lead-capture site.

## Output format for future agents

Every final handoff must report:

1. branch, HEAD, task/acceptance criteria, and product sources used;
2. exact files and behavior changed;
3. checks run with pass/fail/skipped results and UI/accessibility evidence when relevant;
4. provider, deployment, DNS, data, money, email, auth, and legal impact—state `none` explicitly where applicable;
5. the visitor/operator outcome shipped, not a generic “customer impact” statement;
6. assumptions, remaining blockers, rollback/forward-fix notes, and any true hard stop requiring founder action; and
7. PR URL and state, or a statement that no PR was created.
