export const WORKFORCE_ROLES = [
  "owner",
  "gm",
  "manager",
  "shift_lead",
  "cleaner",
] as const;

export type WorkforceRole = (typeof WORKFORCE_ROLES)[number];

export const OPERATIONS_CAPABILITIES = [
  "view_network",
  "manage_organization_roles",
  "manage_teams",
  "manage_members",
  "allocate_jobs",
  "manage_inventory",
  "use_inventory",
  "approve_restock",
  "review_time",
  "manage_compensation",
  "award_bonus",
  "manage_workforce_events",
  "manage_service_recovery",
  "manage_refunds",
] as const;

export type OperationsCapability = (typeof OPERATIONS_CAPABILITIES)[number];

const ROLE_CAPABILITIES: Record<WorkforceRole, readonly OperationsCapability[]> = {
  owner: OPERATIONS_CAPABILITIES,
  gm: OPERATIONS_CAPABILITIES.filter(
    (capability) => capability !== "manage_organization_roles",
  ),
  manager: [
    "manage_members",
    "allocate_jobs",
    "manage_inventory",
    "use_inventory",
    "approve_restock",
    "review_time",
    "manage_compensation",
    "award_bonus",
    "manage_workforce_events",
    "manage_service_recovery",
    "manage_refunds",
  ],
  shift_lead: [
    "allocate_jobs",
    "manage_inventory",
    "use_inventory",
    "manage_workforce_events",
  ],
  cleaner: ["use_inventory"],
};

export type WorkforceMembership = {
  id: string;
  organizationId: string;
  teamId: string | null;
  role: WorkforceRole;
};

const WORKFORCE_ROLE_RANK: Record<WorkforceRole, number> = {
  owner: 0,
  gm: 1,
  manager: 2,
  shift_lead: 3,
  cleaner: 4,
};

export function effectiveRoleForTeam(
  memberships: readonly WorkforceMembership[],
  organizationId: string,
  teamId: string,
): WorkforceRole | null {
  return memberships
    .filter(
      (membership) =>
        membership.organizationId === organizationId &&
        (membership.teamId === null || membership.teamId === teamId),
    )
    .map((membership) => membership.role)
    .sort((left, right) => WORKFORCE_ROLE_RANK[left] - WORKFORCE_ROLE_RANK[right])[0] ?? null;
}

export function hasCapability(
  memberships: readonly WorkforceMembership[],
  capability: OperationsCapability,
  organizationId: string,
  teamId?: string | null,
) {
  return memberships.some(
    (membership) =>
      membership.organizationId === organizationId &&
      (membership.teamId === null || membership.teamId === teamId) &&
      ROLE_CAPABILITIES[membership.role].includes(capability),
  );
}

export function accessibleTeamIds(
  memberships: readonly WorkforceMembership[],
  organizationId: string,
  organizationTeamIds: readonly string[],
) {
  const relevant = memberships.filter(
    (membership) => membership.organizationId === organizationId,
  );
  if (relevant.some((membership) => membership.teamId === null)) {
    return [...new Set(organizationTeamIds)];
  }
  return [
    ...new Set(
      relevant
        .map((membership) => membership.teamId)
        .filter((teamId): teamId is string => Boolean(teamId)),
    ),
  ];
}

export function suggestedReorderQuantity(input: {
  onHand: number;
  reorderPoint: number;
  targetLevel: number;
  automaticReorderEnabled: boolean;
}) {
  if (
    !input.automaticReorderEnabled ||
    input.onHand > input.reorderPoint ||
    input.targetLevel <= input.onHand
  ) {
    return 0;
  }
  return Math.round((input.targetLevel - input.onHand) * 1000) / 1000;
}

export function actualMinutes(input: {
  clockInAt: string | Date;
  clockOutAt: string | Date | null;
  breakMinutes: number;
}) {
  if (!input.clockOutAt) return null;
  const start = new Date(input.clockInAt).getTime();
  const end = new Date(input.clockOutAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return Math.max(0, Math.round((end - start) / 60_000) - input.breakMinutes);
}

export function laborVariance(input: {
  actualMinutes: number;
  estimatedMinutes: number;
}) {
  const deltaMinutes = input.actualMinutes - input.estimatedMinutes;
  const percent = input.estimatedMinutes > 0
    ? Math.round((deltaMinutes / input.estimatedMinutes) * 100)
    : 0;
  return {
    deltaMinutes,
    percent,
    band:
      percent > 20
        ? ("over" as const)
        : percent < -20
          ? ("under" as const)
          : ("on_plan" as const),
  };
}

export function teamAttentionLevel(input: {
  lowStockItems: number;
  openCallouts: number;
  openCriticalEvents: number;
  averageLaborVariancePercent: number | null;
  openServiceCases: number;
}): "healthy" | "watch" | "critical" {
  const score =
    Math.min(input.lowStockItems, 5) * 2 +
    Math.min(input.openCallouts, 5) * 3 +
    input.openCriticalEvents * 6 +
    Math.min(input.openServiceCases, 5) * 2 +
    (input.averageLaborVariancePercent !== null &&
    input.averageLaborVariancePercent > 20
      ? 4
      : 0);
  return score >= 12 ? "critical" : score >= 5 ? "watch" : "healthy";
}
