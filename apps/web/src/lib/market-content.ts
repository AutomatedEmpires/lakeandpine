export type MarketProgram = {
  slug: "estate" | "construction" | "marine" | "commercial";
  eyebrow: string;
  title: string;
  shortTitle: string;
  summary: string;
  bestFor: string[];
  planIncludes: string[];
  boundaries: string;
};

export const MARKET_PROGRAMS: MarketProgram[] = [
  {
    slug: "estate",
    eyebrow: "Private residential",
    title: "Private Estate Care",
    shortTitle: "Estate care",
    summary:
      "Detail-led recurring and project cleaning for large primary residences, lake homes, and seasonal properties where rooms, finishes, access, and household preferences need their own plan.",
    bestFor: [
      "Large primary residences",
      "Lakefront and seasonal homes",
      "Arrival, hosting, and seasonal resets",
      "Households that want a documented room plan",
    ],
    planIncludes: [
      "Priority rooms and finish notes",
      "Occupancy, pet, and access context",
      "Recurring cadence or project window",
      "Closeout notes and issue follow-up",
    ],
    boundaries:
      "An operator reviews the home, requested frequency, access, specialty surfaces, and continuity expectations before confirming fit.",
  },
  {
    slug: "construction",
    eyebrow: "Builders + owners",
    title: "Construction Handoff",
    shortTitle: "Construction handoff",
    summary:
      "A carefully scoped final-clean path for new builds and major renovations—from dust-sensitive detail work through walkthrough preparation and owner arrival.",
    bestFor: [
      "Custom-home builders and project managers",
      "Major residential renovations",
      "Commercial tenant improvements",
      "Owners preparing for handoff or move-in",
    ],
    planIncludes: [
      "Site phase and readiness review",
      "Room, glass, trim, cabinet, and fixture priorities",
      "Walkthrough target and access coordination",
      "Punch-list closeout conversation",
    ],
    boundaries:
      "Heavy debris removal, hazardous materials, mold, active-trade cleanup, high-access exterior glass, and specialty restoration are outside the assumed scope unless separately reviewed and accepted.",
  },
  {
    slug: "marine",
    eyebrow: "Cabin + interior",
    title: "Lake & Marine Interior Care",
    shortTitle: "Marine interiors",
    summary:
      "Interior cleaning plans for boat and yacht cabins, galleys, heads, lounges, and owner spaces—coordinated around marina access, storage status, and departure or arrival timing.",
    bestFor: [
      "Cabins, salons, and lounges",
      "Galleys and interior heads",
      "Pre-arrival and seasonal interior resets",
      "Stored or docked vessels with approved access",
    ],
    planIncludes: [
      "Interior zones and material notes",
      "Dock, storage, and access instructions",
      "Owner-supplied product requirements",
      "Departure or arrival timing preferences",
    ],
    boundaries:
      "This program is for interiors. Hull washing, gelcoat correction, oxidation removal, engine or bilge work, mechanical service, and invasive-species work are not included.",
  },
  {
    slug: "commercial",
    eyebrow: "Professional spaces",
    title: "Select Commercial Care",
    shortTitle: "Commercial care",
    summary:
      "Planned recurring or project cleaning for private offices, studios, showrooms, and client-facing spaces where presentation, access, and operating hours matter.",
    bestFor: [
      "Private offices and professional suites",
      "Studios and showrooms",
      "Owner-operated client spaces",
      "Post-improvement and pre-opening resets",
    ],
    planIncludes: [
      "Zone-by-zone scope and frequency",
      "Operating-hour and keyholder coordination",
      "High-touch and presentation priorities",
      "Issue reporting and scope review",
    ],
    boundaries:
      "Medical, laboratory, food-production, industrial, hazardous, and regulated sanitation work is not assumed. Those environments require separate qualification and written acceptance.",
  },
];

export const SERVICE_STAGES = [
  {
    number: "01",
    title: "Request",
    body: "Share the property type, priorities, timing preferences, and the best way to follow up. A request does not reserve a crew or charge a card.",
  },
  {
    number: "02",
    title: "Scope",
    body: "An operator reviews size, condition, access, finishes, exclusions, and whether a walkthrough or more detail is needed.",
  },
  {
    number: "03",
    title: "Confirm",
    body: "You receive a defined scope, price direction, and confirmed service window before work is treated as scheduled.",
  },
  {
    number: "04",
    title: "Close out",
    body: "The team works from the agreed plan. Questions, missed-scope concerns, and service recovery are documented and reviewed with an operator.",
  },
];

export const OPERATING_POLICIES = [
  {
    title: "Scheduling",
    body: "Choose a preferred date and an alternate. Both are planning preferences until an operator reviews scope, travel, duration, and crew capacity and sends confirmation.",
  },
  {
    title: "Rescheduling",
    body: "Send a change request as early as possible. The original appointment remains in place until the operator confirms a new window; any fee or exception must be disclosed before it is applied.",
  },
  {
    title: "Concerns + complaints",
    body: "Describe the concern and the part of the agreed scope involved. Photos are optional when useful. An operator reviews the job record and responds with the next appropriate step.",
  },
  {
    title: "Service recovery + refunds",
    body: "Depending on the facts, resolution may include a return visit, scope correction, account adjustment, partial refund, or another agreed outcome. No result is automatic before review, and this site does not currently collect online payment.",
  },
];

export const REGION_CLUSTERS = [
  {
    title: "North Idaho lake corridor",
    places: "Coeur d’Alene · Hayden · Post Falls · nearby lake communities",
    body: "Requests are evaluated property by property for route fit, access, project size, and the kind of team the scope requires.",
  },
  {
    title: "Spokane metro corridor",
    places: "Spokane · Spokane Valley · Liberty Lake · nearby communities",
    body: "Availability is confirmed only after the address, requested schedule, travel, and service program are reviewed together.",
  },
];

export const PRICING_FACTORS = [
  "Square footage and usable interior area",
  "Current condition and level of detail",
  "Number of rooms, zones, floors, or vessel spaces",
  "Finish sensitivity and product requirements",
  "Access, parking, marina, gate, or site coordination",
  "Crew size, duration, frequency, and schedule constraints",
  "Construction dust, glass, cabinetry, and walkthrough readiness",
  "Optional interior appliances, windows, laundry, or organization",
];

export const PUBLIC_ROUTE_LINKS = [
  { href: "/", label: "Home" },
  { href: "/who-we-serve", label: "Who we serve" },
  { href: "/services", label: "Services" },
  { href: "/pricing", label: "Pricing" },
  { href: "/areas", label: "Areas" },
];
