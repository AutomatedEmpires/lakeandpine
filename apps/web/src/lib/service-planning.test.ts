import assert from "node:assert/strict";
import test from "node:test";

import { buildPlanningDirection, canTransitionJob } from "./service-planning.ts";

const baseInput = {
  serviceId: "essential" as const,
  property: {
    propertyType: "house" as const,
    sizeBand: "1200_2000" as const,
    bedrooms: "3" as const,
    bathrooms: "2" as const,
    floors: "1" as const,
    condition: "maintained" as const,
  },
  rooms: [
    { id: "kitchen", label: "Kitchen", selected: true, note: "Focus on cabinet fronts" },
    { id: "bathroom", label: "Bathrooms", selected: true },
  ],
  preferences: ["Unscented products"],
  addonIds: [],
};

test("buildPlanningDirection turns room notes and preferences into checklist work", () => {
  const plan = buildPlanningDirection(baseInput);

  assert.equal(plan.effort, "standard");
  assert.match(plan.summary, /2 rooms/);
  assert.ok(plan.checklist.some((item) => item.label.includes("cabinet fronts")));
  assert.ok(plan.checklist.some((item) => item.label === "Preference: Unscented products"));
});

test("buildPlanningDirection routes complex requests to operator review", () => {
  const plan = buildPlanningDirection({
    ...baseInput,
    serviceId: "move",
    property: {
      ...baseInput.property,
      sizeBand: "3000_plus",
      floors: "3_plus",
      condition: "needs_detail",
    },
    addonIds: ["oven", "windows"],
    petNotes: "Two dogs",
  });

  assert.equal(plan.effort, "operator review");
  assert.equal(plan.score, 100);
});

test("job transitions require an operator review before confirmation", () => {
  assert.equal(canTransitionJob("requested", "confirmed"), false);
  assert.equal(canTransitionJob("requested", "reviewing"), true);
  assert.equal(canTransitionJob("ready", "confirmed"), true);
  assert.equal(canTransitionJob("completed", "follow_up"), true);
});
