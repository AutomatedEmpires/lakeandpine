import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import type Stripe from "stripe";

import { optionalEnv, paymentsEnabled } from "@/lib/env";
import { getStripe, stripeConfigured } from "@/lib/stripe";

export const runtime = "nodejs";

const MAX_STRIPE_PAYLOAD_BYTES = 1024 * 1024;
const MAX_STRIPE_SIGNATURE_BYTES = 4096;

type VerifiedStripeReceipt = {
  claimed: boolean;
  receipt_status: "processing" | "processed" | "ignored" | "failed";
  processing_capability: string | null;
  event_id: string;
  event_type: string;
  livemode: boolean;
  payload_sha256: string;
};

class StripePayloadTooLarge extends Error {}

async function readBoundedPayload(request: Request): Promise<string> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength && /^\d+$/.test(declaredLength)) {
    const bytes = Number(declaredLength);
    if (!Number.isSafeInteger(bytes) || bytes > MAX_STRIPE_PAYLOAD_BYTES) {
      throw new StripePayloadTooLarge();
    }
  }

  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_STRIPE_PAYLOAD_BYTES) {
        await reader.cancel();
        throw new StripePayloadTooLarge();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const payloadBytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    payloadBytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(payloadBytes);
}

function isLakeAndPineEvent(event: Stripe.Event): boolean {
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded":
      return event.data.object.metadata?.lakeandpine === "v1";
    case "invoice.paid":
    case "invoice.payment_failed":
      return (
        event.data.object.parent?.subscription_details?.metadata?.lakeandpine === "v1"
      );
    default:
      return false;
  }
}

function isSupportedEvent(event: Stripe.Event): boolean {
  return (
    event.type === "checkout.session.completed" ||
    event.type === "checkout.session.async_payment_succeeded" ||
    event.type === "invoice.paid" ||
    event.type === "invoice.payment_failed"
  );
}

function webhookFailure(code: string): never {
  const error = new Error(code);
  error.name = code;
  throw error;
}

// Stripe's SDK verifies the same raw bytes before the database independently
// verifies them with its separately configured secret. The application role can
// neither write receipt rows nor turn caller-asserted provider fields into billing
// data: completion receives only the database-issued one-use capability.
export async function POST(request: Request) {
  const webhookSecret = optionalEnv("STRIPE_WEBHOOK_SECRET");
  if (!paymentsEnabled || !stripeConfigured() || !webhookSecret) {
    return NextResponse.json({ error: "Stripe webhook not configured" }, { status: 503 });
  }

  const signature = request.headers.get("stripe-signature");
  if (!signature) {
    return NextResponse.json({ error: "Missing signature" }, { status: 400 });
  }
  if (new TextEncoder().encode(signature).byteLength > MAX_STRIPE_SIGNATURE_BYTES) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  let event: Stripe.Event;
  let payload: string;
  try {
    payload = await readBoundedPayload(request);
    event = getStripe().webhooks.constructEvent(payload, signature, webhookSecret);
  } catch (error) {
    if (error instanceof StripePayloadTooLarge) {
      return NextResponse.json({ error: "Payload too large" }, { status: 413 });
    }
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  let receipt: VerifiedStripeReceipt | undefined;
  let database: typeof import("@/lib/db");
  try {
    database = await import("@/lib/db");
    const receipts = await database.sql<VerifiedStripeReceipt[]>`
      select * from private.verify_and_claim_stripe_event(
        ${payload}, ${signature}
      )`;
    receipt = receipts[0];
  } catch {
    return NextResponse.json(
      { error: "Stripe database verification unavailable" },
      { status: 503 },
    );
  }

  const payloadSha256 = createHash("sha256").update(payload).digest("hex");
  if (
    !receipt ||
    receipt.event_id !== event.id ||
    receipt.event_type !== event.type ||
    receipt.livemode !== event.livemode ||
    receipt.payload_sha256 !== payloadSha256
  ) {
    return NextResponse.json({ error: "Stripe verification mismatch" }, { status: 400 });
  }

  if (!receipt.claimed) {
    if (receipt.receipt_status === "processed" || receipt.receipt_status === "ignored") {
      return NextResponse.json({ received: true, duplicate: true });
    }
    return NextResponse.json(
      { error: "Webhook receipt is already processing" },
      { status: 503 },
    );
  }
  if (!receipt.processing_capability) {
    return NextResponse.json(
      { error: "Stripe processing capability unavailable" },
      { status: 503 },
    );
  }

  const processingCapability = receipt.processing_capability;
  try {
    if (isSupportedEvent(event) && isLakeAndPineEvent(event)) {
      const rows = await database.sql<{ completed: boolean }[]>`
        select private.complete_verified_stripe_event(
          ${processingCapability}::uuid
        ) as completed`;
      if (!rows[0]?.completed) webhookFailure("StripeCompletionRejected");
    } else {
      const rows = await database.sql<{ ignored: boolean }[]>`
        select private.ignore_verified_stripe_event(
          ${processingCapability}::uuid
        ) as ignored`;
      if (!rows[0]?.ignored) webhookFailure("StripeIgnoreRejected");
    }
  } catch (error) {
    const errorCode =
      error instanceof Error ? error.name.slice(0, 120) : "WebhookProcessingError";
    try {
      await database.sql`
        select private.fail_verified_stripe_event(
          ${processingCapability}::uuid, ${errorCode}
        )`;
    } catch {
      // Preserve the webhook failure response even if failure persistence is down.
    }
    return NextResponse.json({ error: "Webhook processing failed" }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}
