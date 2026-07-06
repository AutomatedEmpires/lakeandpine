# Recovered Product Truth

This document records what the recovered Lake and Pine prototype visibly implements or clearly represents.

## Recovered Product Truth

### Core surface

- Seven visible application routes: home, services, pricing, booking, service areas, reviews, and customer dashboard.
- Persistent trust and conversion controls: fixed navigation, sticky mobile CTA, direct call action, estimate jump, booking action, and AI concierge entry.
- Responsive behavior for desktop and mobile, including a hamburger-driven mobile menu and single-column mobile layouts.

### Service architecture

- Six concrete service modules are represented: recurring home reset, deep clean, move in or move out clean, vacation-rental turnover, small office refresh, and add-on services.
- Service modules have icons, starting price anchors, descriptive scope, and positioning tags.
- Recurring plan structure is explicitly shown for weekly, bi-weekly, monthly, and one-time service.

### Estimate and pricing system

- An instant estimate studio is implemented with interactive quote inputs and live starting-price calculation.
- Pricing is intentionally framed as transparent starting anchors rather than fixed final pricing.
- Add-ons, home condition, frequency, and service type are all part of the estimating model.

### Booking and scheduling

- Booking is implemented as a six-step client-side flow: service, home, add-ons, schedule, contact, confirm.
- The scheduling concept includes service selection, home details, add-ons, date and time selection, contact capture, review, and confirmation.
- Toast feedback and step-state navigation are present in the booking flow.

### Trust, reviews, and local presence

- Reviews are treated as a first-class route and home-page trust block.
- Local SEO is explicitly represented with service-area content for Coeur d'Alene, Spokane, Hayden, Post Falls, and nearby markets.
- Structured local-business metadata is embedded in the prototype.

### Customer relationship system

- The customer dashboard includes overview, bookings, home notes, billing, and support states.
- Dashboard states show upcoming cleans, completed bookings, stored home preferences, billing history, referral credit, and support access.
- Billing is represented through invoice history and saved payment-state concepts rather than a full accounting backend.
- Communication is represented through cleaner notes, support, review-request status, and concierge interaction.

### AI concierge and interaction states

- Pine Concierge exists as a floating chat panel with open and close behavior.
- Hidden or dynamic interface states include route switching, service rail switching, recurring-plan rendering, estimate recalculation, booking-step changes, dashboard tab changes, chat messages, mobile-menu state, and toast notifications.

### Scope boundaries visible in the prototype

- Invoices are represented conceptually through billing history, but a full invoice-management system is not implemented.
- Referral capability is represented through referral balance or credit, but not a full referral workflow.
- Support is represented as a dashboard surface and concierge concept, not a complete ticketing system.

## Production Requirements

- A Next.js App Router application with TypeScript and pnpm-based tooling.
- Authentication for customer accounts and internal staff roles, likely through Clerk.
- Supabase-backed domain models for customers, homes, bookings, services, service areas, quotes, preferences, reviews, billing records, and support events.
- A real pricing and quote engine that can convert prototype estimate inputs into serviceable quote ranges.
- Booking and scheduling infrastructure with availability, team capacity, rescheduling, cancellation, and service notes.
- Stripe-backed payment methods, invoice records, deposits or charges, and billing-history retrieval.
- Operational messaging through email and transactional notifications, likely with Resend and provider-specific SMS later if needed.
- Product observability and deployment standards covering PostHog, Sentry, Vercel, and configuration management.
- A content strategy for local SEO pages and trust surfaces that matches the prototype's geographic model.
- Guardrails around AI concierge behavior so it supports estimate and booking conversion without pretending to be the source of truth.

## Future Possibilities

- Rich referral workflows beyond the prototype's visible referral-credit concept.
- Two-way messaging, SMS automation, and deeper support operations.
- Staff dispatch, routing, and internal operations tooling beyond what the customer dashboard implies.
- Broader commercial-service workflows if the small-office concept becomes a separate line of business.
- Deeper AI concierge automation after the real quote, booking, and CRM systems exist.