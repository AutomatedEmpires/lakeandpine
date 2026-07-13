import assert from "node:assert/strict";
import test from "node:test";

import {
  MARKET_PROGRAMS,
  OPERATING_POLICIES,
  PRICING_FACTORS,
  PUBLIC_ROUTE_LINKS,
} from "./market-content.ts";

test("premium market content covers the four approved service programs", () => {
  assert.deepEqual(
    MARKET_PROGRAMS.map((program) => program.slug),
    ["estate", "construction", "marine", "commercial"],
  );
  assert.ok(MARKET_PROGRAMS.every((program) => program.bestFor.length >= 4));
  assert.ok(MARKET_PROGRAMS.every((program) => program.planIncludes.length >= 4));
});

test("public positioning avoids unsupported credentials and hard promises", () => {
  const copy = JSON.stringify({ MARKET_PROGRAMS, OPERATING_POLICIES, PRICING_FACTORS });
  assert.doesNotMatch(copy, /licensed|bonded|insured|background.checked|guaranteed|same.day/i);
  assert.match(copy, /continuity expectations/i);
  assert.match(copy, /no result is automatic before review/i);
});

test("navigation includes the premium audience and consultation journey", () => {
  assert.ok(PUBLIC_ROUTE_LINKS.some((link) => link.href === "/who-we-serve"));
  assert.ok(PUBLIC_ROUTE_LINKS.some((link) => link.href === "/areas"));
});
