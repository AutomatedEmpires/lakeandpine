import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(relativeUrl: string) {
  return readFileSync(new URL(relativeUrl, import.meta.url), "utf8");
}

test("dashboard acknowledgements are derived by a bounded database function", () => {
  const actions = source("../app/dashboard/actions.ts");
  const data = source("./data.ts");

  assert.equal(
    actions.match(/appendServiceCaseCustomerAcknowledgement\(/g)?.length,
    2,
  );
  assert.doesNotMatch(actions, /addSupportMessage\([\s\S]{0,120}["']concierge["']/);
  assert.match(
    data,
    /private\.append_service_case_customer_acknowledgement\(\s*\$\{serviceCaseId\}::uuid\s*\)/,
  );
  assert.match(
    data,
    /set_config\(\s*'lakeandpine\.current_customer_id',\s*\$\{customerId\},\s*true\s*\)/,
  );
  assert.doesNotMatch(
    data,
    /appendServiceCaseCustomerAcknowledgement[\s\S]{0,800}insert\s+into\s+support_messages/i,
  );
});

test("customer-authored support messages remain customer-only", () => {
  const data = source("./data.ts");

  assert.match(data, /if \(sender !== "customer"\)/);
  assert.match(
    data,
    /insert into support_messages \(customer_id, sender, body\)[\s\S]{0,100}values \(\$\{customerId\}, 'customer', \$\{body\}\)/,
  );
});
