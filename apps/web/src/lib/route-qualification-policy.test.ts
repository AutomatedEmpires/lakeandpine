import assert from "node:assert/strict";
import test from "node:test";

import { isAutoQualifyingMapboxAddress } from "./route-qualification-policy.ts";

const exactAddress = {
  featureType: "address",
  confidence: "exact",
  addressNumber: "matched",
  street: "matched",
  postcode: "matched",
  place: "matched",
  region: "matched",
  country: "inferred",
  coordinateAccuracy: "rooftop",
};

test("only an exact component-level address match can qualify automatically", () => {
  assert.equal(isAutoQualifyingMapboxAddress(exactAddress), true);
  assert.equal(
    isAutoQualifyingMapboxAddress({ ...exactAddress, confidence: "high" }),
    false,
  );
  assert.equal(
    isAutoQualifyingMapboxAddress({ ...exactAddress, postcode: "unmatched" }),
    false,
  );
  assert.equal(
    isAutoQualifyingMapboxAddress({
      ...exactAddress,
      coordinateAccuracy: "interpolated",
    }),
    false,
  );
});
