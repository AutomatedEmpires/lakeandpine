import assert from "node:assert/strict";
import test from "node:test";

import {
  boundedCurrencyCents,
  boundedDecimalValue,
  formUuid,
  formValue,
} from "./form-values.ts";

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

test("parses refund dollars into exact, bounded cents", () => {
  for (const [raw, cents] of [
    ["0.01", 1],
    [".5", 50],
    ["10.05", 1_005],
    ["19.99", 1_999],
    ["10000.00", 1_000_000],
  ] as const) {
    assert.equal(
      boundedCurrencyCents(data("amount", raw), "amount", {
        minCents: 1,
        maxCents: 1_000_000,
      }),
      cents,
    );
  }

  for (const raw of ["0", "-1", "0.001", "1e2", "10000.01"]) {
    assert.throws(() =>
      boundedCurrencyCents(data("amount", raw), "amount", {
        minCents: 1,
        maxCents: 1_000_000,
      }),
    );
  }
});
