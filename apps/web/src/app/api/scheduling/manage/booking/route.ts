import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { guestManagementTokenSchema } from "@/lib/customer-scheduling-contract";
import { getGuestManagedBooking } from "@/lib/customer-scheduling-data";
import { customerSchedulingEnabled } from "@/lib/env";
import { GUEST_MANAGEMENT_COOKIE } from "@/lib/guest-management";

export async function GET() {
  if (!customerSchedulingEnabled) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const cookieStore = await cookies();
  const parsed = guestManagementTokenSchema.safeParse(
    cookieStore.get(GUEST_MANAGEMENT_COOKIE)?.value,
  );
  if (!parsed.success) {
    return NextResponse.json({ error: "Management access required." }, { status: 401 });
  }
  const booking = await getGuestManagedBooking(parsed.data);
  if (!booking) {
    cookieStore.delete(GUEST_MANAGEMENT_COOKIE);
    return NextResponse.json(
      { error: "Management access expired or was revoked." },
      { status: 403 },
    );
  }
  return NextResponse.json({ booking });
}
