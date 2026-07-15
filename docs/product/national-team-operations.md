# National team operations

## Product outcome

Lake & Pine now has an organization and team operating layer designed to grow from one
local crew into a national service company. Each team has an isolated operating ledger,
schedule, inventory, workforce, time, compensation, bonus, and incident scope. The owner
and general managers can see the organization across teams; local managers and shift
leads can act only inside their assigned teams; cleaners can see and record only the
work that belongs to them.

This layer is operational control software, not a payroll processor, purchasing bot, or
automatic disciplinary system. Reorders, bonuses, pay rates, refunds, and workforce
events remain approval-gated records until an authorized human completes the relevant
real-world action.

## Hierarchy and permissions

| Role | Scope | Capabilities |
| --- | --- | --- |
| Owner | Entire organization | National dashboard, teams, members, scheduling, inventory, restock approvals, time approval, compensation, bonuses, and workforce events |
| General manager | Entire organization | All operating capabilities across teams; ownership and organization-role control remain owner-only |
| Manager | Assigned team | Members below manager level, schedules, inventory, restock approvals, time and PTO approval, compensation, bonuses, workforce events, service recovery, and refund review |
| Shift lead | Assigned team | Staff-backed leads use local dispatch, inventory control, and workforce-event reporting; cleaner-backed field leads use the crew clock, inventory usage, restock, and callout workflows |
| Cleaner | Assigned team and self | Personal assignments, clock in/out, time-off request, callout, inventory usage, restock request, and personal bonus history |

An organization-wide membership has no team ID and can access every team in that
organization. A local membership always carries a team ID. The application sets the
authenticated actor inside each database transaction, and row-level security enforces
the same boundaries in PostgreSQL. A missing or mismatched actor context fails closed.

## Operator surfaces

- `/operator/network` — national control tower, team health, national totals, team
  creation, and role assignment.
- `/operator/schedule` — team job allocation, capacity-aware schedule suggestions,
  candidate proposals, and controlled schedule transitions.
- `/operator/field` — branch radius and hours, route exceptions, customer-approved
  arrival windows, manager-on-duty coverage, mileage, field issues, communication audit,
  and non-cash tip intent.
- `/operator/inventory` — product catalog, purchase link, unit cost, opening count,
  stock ledger, cleaner usage, restock queue, and receiving.
- `/operator/workforce` — team roster and append-only callout, no-show, coaching,
  warning, recognition, leave, suspension, and termination records.
- `/operator/time` — clocked time, estimated-versus-actual minutes, labor variance,
  and manager approval or rejection.
- `/operator/compensation` — effective-dated pay-rate records and proposed bonus
  awards. These records do not transmit payroll funds.
- `/operator/recovery` — team-scoped complaints, case lifecycle, rescheduling,
  cancellation, recovery actions, and evidence-backed refund review. It never moves
  money.
- `/crew` — cleaner assignment response, exact assigned location, approved arrival
  window, checklist, audited customer updates, mileage, field issues, time off, clock
  in/out, product usage, restock request, callout, and bonus history.

The previous global operator dashboards are restricted to owner and general-manager
memberships because their legacy queries are organization-wide. Team managers and shift
leads use the new scoped surfaces. A shift lead who owns local dispatch needs a staff
identity; a cleaner-backed shift lead remains in `/crew` so legacy field-lead access does
not silently become an administrative login.

## Inventory system

Inventory is a team-owned ledger rather than a mutable shared number:

1. An authorized operator creates a product in one team with SKU, vendor, purchase URL,
   unit price, unit of measure, reorder point, target level, and opening count.
2. Every use, adjustment, receipt, return, waste record, and transfer is an immutable
   `inventory_transactions` row.
3. A database trigger updates the materialized on-hand quantity. Direct edits to on-hand
   stock are rejected, and transactions that would make stock negative are rejected.
4. Cleaner usage is accepted only from an active cleaner membership in the same team.
5. If automatic reorder is enabled and stock falls to or below its threshold, the
   database creates exactly one open `automatic_threshold` restock draft for the amount
   needed to reach the target level.
6. A manager or higher approves or rejects the draft. Approval never submits an order.
   Receiving approved stock posts a receipt transaction and closes the request.

Every product, stock row, transaction, and restock record carries both organization and
team identity. Composite foreign keys prevent data from being connected across teams,
even if application code is incorrect.

## Intelligent scheduling and labor performance

The scheduling engine first applies hard constraints already maintained by the premium
service-planning layer: availability, time off, service qualification, territory,
duration, capacity, and schedule conflict. The team layer then limits candidates to
active cleaner memberships in the selected team. Operators see ranked candidates and
reasons before proposing or confirming a schedule.

Each active service territory can be enabled or paused per team. That mapping is the
boundary for the local incoming-work queue: managers and shift leads can allocate only
qualified, currently unallocated schedules in their own team's active coverage. Pausing
coverage removes new work from the queue without rewriting existing assignments.
The dispatch-capable shift-lead identity is staff-backed; cleaner-backed leads retain
the full field workflow in the crew portal.

Each scheduled job can be allocated to one operating team. Cleaner time entries are
linked to that allocation and store clock-in, clock-out, break time, and computed actual
minutes. The management view compares actual minutes with the job estimate:

- within 20% is `on_plan`;
- more than 20% over is `over`; and
- more than 20% under is `under` and should be reviewed for scope or quality accuracy.

Team health combines low stock, open callouts, critical workforce events, open service
cases, and average labor variance into `healthy`, `watch`, or `critical`. The score is a
triage signal, never an automatic employment decision.

## Pay, reviews, and workforce controls

Compensation rates are effective-dated and cannot overlap for the same membership.
Managers can record hourly, salary, or per-job rates with an audit creator, but
the application deliberately does not run payroll or move money.

Bonus tiers may be configured by rating threshold. A bonus draft can be generated only
from verified customer feedback tied to a completed job and a qualified cleaner. Public
review volume or unverified reputation data cannot create an award. Operators may also
create a proposed bonus with a reason; payment remains a separate authorized step.

Workforce events form a durable record for callouts, no-shows, lateness, policy strikes,
coaching, warnings, recognition, suspension, resignation, termination, hiring, and other
documented events. Time-off requests use the dedicated leave workflow. Creating an event
does not fire, suspend, penalize, or pay anyone automatically. Employment policies,
legal review, and authorized human decisions remain required.

## Premium service recovery

Complaints and refund reviews inherit and retain explicit operating-team ownership from
the booked job's allocation. A case cannot attach to an allocation from another team.
The scheduling schema deliberately permits only one schedule per booking, preserving a
single service-visit and team owner for every case. Owners and general managers can work
across the organization; a manager can
act only on cases allocated to their selected team. Valid state transitions are enforced
before any mutation. Rescheduling locks the case, booking, and schedule together and
rechecks time, territory, and crew constraints. Recovery actions retain an accountable
owner and lifecycle. A refund can be reviewed, approved, declined, or marked ready for
manual processing; recording it as processed requires an external provider reference.
No application action sends funds.

## Competitive operating benchmark

The design follows the strongest operational patterns found in current field-service
and janitorial platforms while keeping Lake & Pine's premium-property model distinct:

- [Swept](https://sweptworks.com/features/janitorial-supply-inventory-management-system)
  validates supply requests and planned-versus-actual janitorial work.
- [Aspire](https://www.youraspire.com/features/purchasing) validates purchasing
  controls and job-cost visibility.
- [ServiceTitan](https://help.servicetitan.com/docs/enterprise-hub) validates
  national tenant governance and permissioned payroll data.
- [Connecteam](https://help.connecteam.com/en/articles/6741264-time-off-admins-permissions)
  validates hierarchy, user lifecycle, and time-off administration.
- [Jobber](https://help.getjobber.com/hc/en-us/articles/115009614247-Approving-Timesheets)
  validates granular permissions, timesheet approval, and job costing.
- [Housecall Pro](https://help.housecallpro.com/en/articles/7119757-material-inventory-detail-tracking)
  validates job-linked material tracking and field time capture.

Lake & Pine adds hard organization/team isolation, immutable inventory provenance,
approval-gated automation, property-continuity scheduling, and explicit premium estate,
construction-handoff, marine-interior, and select-commercial operating boundaries.

## Deliberate next integrations

The foundation is ready for provider integrations without making them prerequisites for
the initial launch:

- staff and cleaner invitation plus role-provisioning automation on top of the
  existing Clerk-authenticated production login;
- a vendor purchasing connector that converts an approved restock into an order;
- payroll export or provider sync after compensation policy and provider selection;
- notification delivery for schedule, restock, time-off, and service-case events;
- background jobs for reminders and stale-request escalation; and
- analytics history for trend lines, forecasting, recruiting needs, and cohort quality.

Each integration should consume the existing approval and audit records. It must not
bypass team scope or convert a recommendation into money movement or employment action
without an authorized decision.
