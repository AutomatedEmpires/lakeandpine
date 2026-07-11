# Production Foundation

## Objective

Lake and Pine should optimize for:

visitor -> trust -> estimate -> book -> repeat service -> customer relationship

## Foundation choices

- App structure: single Next.js App Router application at `apps/web`
- Language and package tooling: TypeScript + pnpm
- Immediate architecture style: one web application first, no forced marketplace-style multi-package domain split
- Preserved historical source: `prototypes/recovered/2026-06-24/lake_pine_cleaning_visionary_v3.html`

## Intended production services

- Clerk for authentication and customer account access
- Supabase for application data and operational state
- Stripe for payment methods, invoices, and recurring billing events
- PostHog for product analytics and conversion instrumentation
- Sentry for runtime monitoring
- Resend for transactional email
- Vercel for deployment
- Doppler for environment management

## Near-term implementation slices

- Public marketing and conversion surface
- Estimate and quote system
- Booking and scheduling system
- Customer dashboard and billing history
- Operational notifications and concierge assist

## Deliberate non-goals for this branch

- No direct implementation from the recovered HTML artifact
- No broad refactor of the recovered historical materials
- No premature internal operations platform beyond what the customer journey needs

## Open architecture decisions

- Whether staff operations live inside the same web app or behind a separate protected surface
- Whether recurring service scheduling should start as rule-based capacity or calendar-backed availability
- Whether concierge begins as guided UX plus contact capture or as a live AI-assisted workflow on day one