import assert from "node:assert/strict";
import test from "node:test";

import { normalizePhoneHref } from "./env.ts";

test("normalizes North American business phone formats without duplicating country code", () => {
  assert.equal(normalizePhoneHref("(208) 765-4321"), "tel:+12087654321");
  assert.equal(normalizePhoneHref("1 (208) 765-4321"), "tel:+12087654321");
  assert.equal(normalizePhoneHref("+1 (208) 765-4321"), "tel:+12087654321");
});

test("preserves a supplied international E.164 country code", () => {
  assert.equal(normalizePhoneHref("+44 20 7946 0958"), "tel:+442079460958");
});

test("rejects empty, ambiguous, or invalid public phone configurations", () => {
  assert.equal(normalizePhoneHref(), undefined);
  assert.equal(normalizePhoneHref(""), undefined);
  assert.equal(normalizePhoneHref("020 7946 0958"), undefined);
  assert.equal(normalizePhoneHref("+012345678"), undefined);
  assert.equal(normalizePhoneHref("+1234567890123456"), undefined);
});
