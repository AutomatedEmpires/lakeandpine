import assert from "node:assert/strict";
import test from "node:test";

import { deriveRequestPlanning } from "./premium-request.ts";

test("estate request produces a remote scope direction for a maintained standard property", () => {
  const result = deriveRequestPlanning({
    program: "estate",
    sizeBand: "standard",
    condition: "maintained",
    zoneCount: 7,
    deadlineCritical: false,
    finishSensitive: false,
    accessComplex: false,
  });

  assert.equal(result.reviewPath, "remote scope review");
  assert.equal(result.estimatedCrewSize, 1);
  assert.equal(result.estimatedMinutes, 300);
});

test("construction handoff recommends a walkthrough and larger crew direction", () => {
  const result = deriveRequestPlanning({
    program: "construction",
    sizeBand: "large",
    condition: "project",
    zoneCount: 16,
    deadlineCritical: true,
    finishSensitive: true,
    accessComplex: true,
  });

  assert.equal(result.reviewPath, "walkthrough recommended");
  assert.equal(result.estimatedCrewSize, 4);
  assert.ok(result.estimatedMinutes >= 1200);
  assert.ok(result.factors.includes("handoff or arrival deadline"));
});

test("marine interior request routes finish and access complexity to an operator call", () => {
  const result = deriveRequestPlanning({
    program: "marine",
    sizeBand: "compact",
    condition: "detailed",
    zoneCount: 4,
    deadlineCritical: false,
    finishSensitive: true,
    accessComplex: true,
  });

  assert.equal(result.reviewPath, "operator call");
  assert.ok(result.factors.includes("access or mobilization coordination"));
});

