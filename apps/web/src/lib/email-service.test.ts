import assert from "node:assert/strict";
import test from "node:test";

import { createEmailService, type EmailMessage } from "./email-service.ts";

function createHarness() {
  const messages: EmailMessage[] = [];
  const logs: string[] = [];
  let transportCreations = 0;
  const service = createEmailService({
    apiKey: "re_present_and_would_send_without_suppression",
    appUrl: "https://example.invalid",
    businessEmail: "ops@example.invalid",
    businessPhone: "208-555-0100",
    from: "Lake & Pine <hello@example.invalid>",
    replyTo: "hello@example.invalid",
    formatLongDate: () => "Tuesday, July 14",
    createTransport: () => {
      transportCreations += 1;
      return {
        async send(message) {
          messages.push(message);
        },
      };
    },
    log: (message) => logs.push(message),
  });
  return { service, messages, logs, transportCreations: () => transportCreations };
}

const booking = {
  to: "runtime-smoke@example.invalid",
  name: "Runtime Smoke",
  serviceTitle: "Pine & Polish Deep Clean",
  date: "2026-07-14",
  window: "10:00 AM",
  estimateDollars: 427,
  bookingId: "00000000-0000-0000-0000-000000000000",
};

test("authorized smoke suppresses customer and both ops emails even with credentials", async () => {
  const harness = createHarness();
  const delivery = { suppress: true };

  await harness.service.sendBookingConfirmation(booking, delivery);
  await harness.service.sendOpsNotification(
    { kind: "lead", summary: "Runtime lead", detailLines: ["synthetic"] },
    delivery,
  );
  await harness.service.sendOpsNotification(
    { kind: "booking", summary: "Runtime booking", detailLines: ["synthetic"] },
    delivery,
  );

  assert.equal(harness.transportCreations(), 0);
  assert.deepEqual(harness.messages, []);
  assert.equal(harness.logs.length, 3);
  assert.ok(harness.logs.every((line) => line.startsWith("[email:suppressed]")));
});

test("ordinary credentialed delivery still uses the configured transport", async () => {
  const harness = createHarness();
  const delivery = { suppress: false };

  await harness.service.sendBookingConfirmation(booking, delivery);
  await harness.service.sendOpsNotification(
    { kind: "booking", summary: "Real booking", detailLines: ["real"] },
    delivery,
  );

  assert.equal(harness.transportCreations(), 1);
  assert.equal(harness.messages.length, 2);
  assert.equal(harness.messages[0].to, booking.to);
  assert.equal(harness.messages[1].to, "ops@example.invalid");
  assert.ok(harness.messages.every((message) => message.replyTo === "hello@example.invalid"));
});
