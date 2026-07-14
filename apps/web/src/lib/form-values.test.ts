import assert from "node:assert/strict";
import test from "node:test";

import { boundedDecimalValue, formUuid, formValue } from "./form-values.ts";

function data(key: string, value: string) {
  const formData = new FormData();
  formData.set(key, value);
  return formData;
}

test("reads trimmed form values and validates UUIDs", () => {
  assert.equal(formValue(data("name", "  Lake & Pine  "), "name"), "Lake & Pine");
  assert.equal(
    formUuid(data("id", "123e4567-e89b-42d3-a456-426614174000"), "id"),
    "123e4567-e89b-42d3-a456-426614174000",
  );
  assert.throws(() => formUuid(data("id", "not-a-uuid"), "id"));
});

test("validates decimal precision from text instead of binary floats", () => {
  for (const raw of ["19.9", "19.99", "10.05", "1.001"]) {
    assert.equal(
      boundedDecimalValue(data("amount", raw), "amount", {
        min: 0,
        max: 100,
        decimals: 3,
      }),
      Number(raw),
    );
  }
  assert.throws(() =>
    boundedDecimalValue(data("amount", "1.0001"), "amount", {
      min: 0,
      max: 100,
      decimals: 3,
    }),
  );
  assert.throws(() =>
    boundedDecimalValue(data("amount", "1e2"), "amount", {
      min: 0,
      max: 100,
      decimals: 2,
    }),
  );
});
