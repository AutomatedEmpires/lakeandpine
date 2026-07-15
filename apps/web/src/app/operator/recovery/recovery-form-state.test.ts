import assert from "node:assert/strict";
import test from "node:test";

import {
  confirmationPreventsSubmission,
  resolutionSummaryFieldState,
} from "./recovery-form-state.ts";

test("resolution summaries are required only for resolved and closed cases", () => {
  assert.deepEqual(resolutionSummaryFieldState("resolved"), {
    required: true,
    placeholder: "Required customer-visible outcome",
  });
  assert.deepEqual(resolutionSummaryFieldState("closed"), {
    required: true,
    placeholder: "Required customer-visible outcome",
  });
  assert.deepEqual(resolutionSummaryFieldState("investigating"), {
    required: false,
    placeholder: "Customer-visible outcome when resolving or closing",
  });
});

test("a declined cancellation confirmation prevents submission", () => {
  const prompts: string[] = [];
  const message = "Cancel this booking?";
  assert.equal(
    confirmationPreventsSubmission(message, (prompt) => {
      prompts.push(prompt);
      return false;
    }),
    true,
  );
  assert.deepEqual(prompts, [message]);
  assert.equal(confirmationPreventsSubmission(message, () => true), false);
});
