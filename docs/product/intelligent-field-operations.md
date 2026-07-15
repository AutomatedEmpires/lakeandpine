# Intelligent field operations

## Product outcome

Lake & Pine now has an approval-gated field workflow connecting the customer, assigned
cleaner, branch manager, general manager, and national owner. A request may come from
outside a branch's ordinary radius, but it is never silently rejected. It receives an
auditable location assessment and must be approved as a route exception before a
customer schedule proposal can be sent.

The first operating branch is configured for downtown Coeur d'Alene, Idaho, a 30-mile
standard radius, Pacific time, two-hour arrival windows, a latest arrival of 4:00 PM,
and a hard service finish of 7:00 PM. Branch origin, coordinates, radius, operating
hours, support alias, and public phone are editable by an authorized manager or higher.
Each future team owns an independent copy of those rules and all resulting records.

## Scheduling contract

The customer can request one of four arrival windows: 8:00–10:00 AM, 10:00 AM–12:00
PM, 12:00–2:00 PM, or 2:00–4:00 PM. The engine keeps later windows available when the
estimated duration fits, but removes a window if the work would arrive after 4:00 PM or
finish after 7:00 PM. For example, six hours of work can still use the 12:00–2:00 PM
window if the planned start is no later than 1:00 PM; it cannot be placed in the 2:00–
4:00 PM window.

A request and a confirmed schedule are intentionally different records:

1. Intake stores the exact service address and an immutable assessment snapshot.
2. The branch accepts an inside-radius assessment or documents an exception.
3. A manager proposes a supported arrival window to the linked customer.
4. The customer approves the proposal or sends it back with a change note.
5. Only an approved proposal permits the schedule to become confirmed.

An out-of-radius or ungeocoded request remains in the operating queue for human review.
It is not automatically promised, rejected, or discarded.

## Customer controls

The dashboard's Service control surface includes:

- schedule proposal approval and change requests;
- audited messages with the assigned team;
- preferred or avoided cleaner continuity based on a shared service job;
- verified reviews tied to completed assigned work;
- customer-visible field issues; and
- tip intent after closeout.

A tip amount is a non-cash intent. It does not charge a card or pay a cleaner. A manager
may mark it recorded only with a real external payment reference and an accountable
membership. Refunds remain in the separate evidence-backed recovery workflow and also
cannot move money without a provider integration.

## Cleaner controls

The crew workspace shows the exact assigned address, approved arrival window, schedule,
manager or lead on duty, job checklist, and communication history. An assigned cleaner
can send the audited 15-minute or 30-minute late template, send a bounded custom update,
record mileage, report schedule/access/safety/vehicle/customer/scope/inventory/quality
issues, and complete checklist items.

Cleaner writes require an active cleaner-backed membership in the allocated team and an
accepted assignment to the job. Cleaners cannot approve their own mileage, close their
own escalations as management, record collected tips, or read another team's work.

## Management and national controls

`/operator/field` is the branch control queue for:

- branch radius, coordinates, service hours, support alias, and phone;
- route exceptions and their documented reason;
- customer arrival-window proposals and final confirmation;
- manager/shift-lead duty coverage;
- mileage approval or rejection;
- issue acknowledgement, resolution, or dismissal with resolution evidence;
- complete job-message audit; and
- non-cash tip-intent reconciliation.

Managers operate only in their team. Shift leads have field execution and communication
authority but not route-exception, customer-schedule, mileage-approval, or duty-roster
authority. Owners and general managers can select any team in their organization. The
database repeats those boundaries with composite team foreign keys, actor-validation
triggers, and row-level security; the UI is not the security boundary.

## Location qualification and privacy

Server-side geocoding is optional. `MAPBOX_ACCESS_TOKEN` is never sent to the browser.
Exact address coordinates are persisted only when
`MAPBOX_PERMANENT_GEOCODING_ENABLED=true` and the Mapbox account is entitled to
permanent geocoding. Otherwise intake stores the request and routes it to manual review.
The public map token is separate and does not qualify a service address.

The assessment retains the address fingerprint, branch-origin snapshot, radius,
distance, method, provider, status, override actor, and override reason so a later
branch-config change does not rewrite the historical decision.

## Deliberate provider boundaries

This release records but does not itself perform SMS/email delivery, payment collection,
tip payout, refunds, payroll, supply purchasing, hiring, firing, or discipline. Those
actions require verified providers, authorized policy, and production evidence. The
operating records are designed so later integrations consume an approved decision
instead of bypassing it.
