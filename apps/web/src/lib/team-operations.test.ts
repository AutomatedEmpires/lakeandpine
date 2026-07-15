import assert from "node:assert/strict";
import test from "node:test";

import {
  accessibleTeamIds,
  actualMinutes,
  effectiveRoleForTeam,
  hasCapability,
  laborVariance,
  suggestedReorderQuantity,
  teamAttentionLevel,
  type WorkforceMembership,
} from "./team-operations.ts";

const memberships: WorkforceMembership[] = [
  { id: "owner", organizationId: "org-a", teamId: null, role: "owner" },
  { id: "gm", organizationId: "org-e", teamId: null, role: "gm" },
  { id: "manager", organizationId: "org-b", teamId: "team-b1", role: "manager" },
  { id: "lead", organizationId: "org-c", teamId: "team-c1", role: "shift_lead" },
  { id: "cleaner", organizationId: "org-d", teamId: "team-d1", role: "cleaner" },
];

test("role capabilities remain team and organization scoped", () => {
  assert.equal(hasCapability(memberships, "manage_teams", "org-a", "team-a2"), true);
  assert.equal(hasCapability(memberships, "manage_organization_roles", "org-a"), true);
  assert.equal(hasCapability(memberships, "manage_service_recovery", "org-a", "team-a2"), true);
  assert.equal(hasCapability(memberships, "manage_refunds", "org-a", "team-a2"), true);
  assert.equal(hasCapability(memberships, "manage_organization_roles", "org-e"), false);
  assert.equal(hasCapability(memberships, "manage_service_recovery", "org-e", "team-e1"), true);
  assert.equal(hasCapability(memberships, "manage_refunds", "org-e", "team-e1"), true);
  assert.equal(hasCapability(memberships, "manage_compensation", "org-b", "team-b1"), true);
  assert.equal(hasCapability(memberships, "manage_compensation", "org-b", "team-b2"), false);
  assert.equal(hasCapability(memberships, "manage_service_recovery", "org-b", "team-b1"), true);
  assert.equal(hasCapability(memberships, "manage_refunds", "org-b", "team-b1"), true);
  assert.equal(hasCapability(memberships, "manage_service_recovery", "org-c", "team-c1"), false);
  assert.equal(hasCapability(memberships, "manage_refunds", "org-c", "team-c1"), false);
  assert.equal(hasCapability(memberships, "manage_service_recovery", "org-d", "team-d1"), false);
  assert.equal(hasCapability(memberships, "manage_refunds", "org-d", "team-d1"), false);
  assert.equal(hasCapability(memberships, "approve_restock", "org-c", "team-c1"), false);
  assert.equal(hasCapability(memberships, "use_inventory", "org-d", "team-d1"), true);
  assert.equal(hasCapability(memberships, "use_inventory", "org-d", "team-d2"), false);
});

test("organization-wide roles expand to all organization teams", () => {
  assert.deepEqual(
    accessibleTeamIds(memberships, "org-a", ["team-a1", "team-a2"]),
    ["team-a1", "team-a2"],
  );
  assert.deepEqual(
    accessibleTeamIds(memberships, "org-b", ["team-b1", "team-b2"]),
    ["team-b1"],
  );
});

test("effective team role uses the highest in-scope organization or team membership", () => {
  const overlapping: WorkforceMembership[] = [
    { id: "cleaner-a", organizationId: "org-a", teamId: "team-a1", role: "cleaner" },
    { id: "lead-a", organizationId: "org-a", teamId: "team-a1", role: "shift_lead" },
    { id: "manager-other", organizationId: "org-a", teamId: "team-a2", role: "manager" },
    { id: "gm-a", organizationId: "org-a", teamId: null, role: "gm" },
    { id: "owner-other", organizationId: "org-b", teamId: null, role: "owner" },
  ];

  assert.equal(effectiveRoleForTeam(overlapping, "org-a", "team-a1"), "gm");
  assert.equal(
    effectiveRoleForTeam(
      overlapping.filter((membership) => membership.id !== "gm-a"),
      "org-a",
      "team-a1",
    ),
    "shift_lead",
  );
  assert.equal(effectiveRoleForTeam(overlapping, "org-a", "team-missing"), "gm");
  assert.equal(effectiveRoleForTeam(overlapping, "org-c", "team-a1"), null);
});

test("reorder drafts are recommended only at or below the threshold", () => {
  assert.equal(
    suggestedReorderQuantity({
      onHand: 4.5,
      reorderPoint: 5,
      targetLevel: 12,
      automaticReorderEnabled: true,
    }),
    7.5,
  );
  assert.equal(
    suggestedReorderQuantity({
      onHand: 6,
      reorderPoint: 5,
      targetLevel: 12,
      automaticReorderEnabled: true,
    }),
    0,
  );
});

test("time intelligence subtracts breaks and reports plan variance", () => {
  const minutes = actualMinutes({
    clockInAt: "2030-01-01T16:00:00.000Z",
    clockOutAt: "2030-01-01T19:30:00.000Z",
    breakMinutes: 30,
  });
  assert.equal(minutes, 180);
  assert.deepEqual(laborVariance({ actualMinutes: minutes!, estimatedMinutes: 150 }), {
    deltaMinutes: 30,
    percent: 20,
    band: "on_plan",
  });
  assert.equal(
    laborVariance({ actualMinutes: 190, estimatedMinutes: 150 }).band,
    "over",
  );
});

test("team attention combines stock, reliability, service, and labor exceptions", () => {
  assert.equal(
    teamAttentionLevel({
      lowStockItems: 0,
      openCallouts: 0,
      openCriticalEvents: 0,
      averageLaborVariancePercent: 4,
      openServiceCases: 0,
    }),
    "healthy",
  );
  assert.equal(
    teamAttentionLevel({
      lowStockItems: 2,
      openCallouts: 1,
      openCriticalEvents: 1,
      averageLaborVariancePercent: 25,
      openServiceCases: 1,
    }),
    "critical",
  );
});
