import assert from "node:assert/strict";
import test from "node:test";

import {
  canTransitionQualification,
  canTransitionRecovery,
  canTransitionRefund,
  canTransitionSchedule,
  canTransitionServiceCase,
} from "./operations-workflows.ts";

test("premium work requires qualification before approval", () => {
  assert.equal(canTransitionQualification("requested", "approved"), false);
  assert.equal(canTransitionQualification("requested", "walkthrough_needed"), true);
  assert.equal(canTransitionQualification("proposal_sent", "approved"), true);
  assert.equal(canTransitionQualification("approved", "requested"), false);
});

test("schedule lifecycle preserves dispatch and quality-review steps", () => {
  assert.equal(canTransitionSchedule("confirmed", "in_progress"), false);
  assert.equal(canTransitionSchedule("confirmed", "en_route"), true);
  assert.equal(canTransitionSchedule("in_progress", "quality_review"), true);
  assert.equal(canTransitionSchedule("quality_review", "completed"), true);
});

test("service recovery can reopen a resolved complaint but not a closed case", () => {
  assert.equal(canTransitionServiceCase("submitted", "resolved"), false);
  assert.equal(canTransitionServiceCase("action_planned", "reclean_scheduled"), true);
  assert.equal(canTransitionServiceCase("resolved", "investigating"), true);
  assert.equal(canTransitionServiceCase("closed", "investigating"), false);
  assert.equal(canTransitionRecovery("approved", "scheduled"), true);
});

test("refund records stop before live money and require a manual-processing state", () => {
  assert.equal(canTransitionRefund("requested", "processed"), false);
  assert.equal(canTransitionRefund("approved", "ready_for_manual_processing"), true);
  assert.equal(canTransitionRefund("ready_for_manual_processing", "processed"), true);
  assert.equal(canTransitionRefund("processed", "failed"), false);
});
