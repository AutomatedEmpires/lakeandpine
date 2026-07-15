import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(fileName: string) {
  return readFileSync(new URL(fileName, import.meta.url), "utf8");
}

test("public cleaner intake uses one bounded database function", () => {
  const cleanerApplications = source("./cleaner-applications.ts");

  assert.match(
    cleanerApplications,
    /private\.create_public_cleaner_application\s*\(/,
  );
  assert.doesNotMatch(
    cleanerApplications,
    /\b(?:from|into|update|delete\s+from)\s+cleaner_applications\b/i,
  );
});

test("request throttling cannot mutate the shared counter table directly", () => {
  const rateLimit = source("./rate-limit.ts");

  assert.match(rateLimit, /private\.consume_request_rate_limit\s*\(/);
  assert.doesNotMatch(rateLimit, /\brequest_rate_limits\b/i);
});
