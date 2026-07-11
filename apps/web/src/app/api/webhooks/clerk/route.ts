import { NextResponse } from "next/server";
import { Webhook } from "svix";

import { upsertCustomerFromClerk } from "@/lib/data";
import { optionalEnv } from "@/lib/env";

type ClerkUserEvent = {
  type: string;
  data: {
    id: string;
    email_addresses?: { email_address: string; id: string }[];
    primary_email_address_id?: string | null;
    first_name?: string | null;
    last_name?: string | null;
    phone_numbers?: { phone_number: string }[];
  };
};

// Svix-verified Clerk events keep the customers table in sync with accounts.
export async function POST(request: Request) {
  const secret = optionalEnv("CLERK_WEBHOOK_SECRET");
  if (!secret) {
    return NextResponse.json({ error: "Clerk webhook not configured" }, { status: 503 });
  }

  const payload = await request.text();
  const headers = {
    "svix-id": request.headers.get("svix-id") ?? "",
    "svix-timestamp": request.headers.get("svix-timestamp") ?? "",
    "svix-signature": request.headers.get("svix-signature") ?? "",
  };

  let event: ClerkUserEvent;
  try {
    event = new Webhook(secret).verify(payload, headers) as ClerkUserEvent;
  } catch {
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  if (event.type === "user.created" || event.type === "user.updated") {
    const data = event.data;
    const primaryEmail =
      data.email_addresses?.find((e) => e.id === data.primary_email_address_id)?.email_address ??
      data.email_addresses?.[0]?.email_address ??
      null;
    const fullName = [data.first_name, data.last_name].filter(Boolean).join(" ") || null;
    await upsertCustomerFromClerk({
      clerkUserId: data.id,
      email: primaryEmail,
      fullName,
      phone: data.phone_numbers?.[0]?.phone_number ?? null,
    });
  }

  return NextResponse.json({ received: true });
}
