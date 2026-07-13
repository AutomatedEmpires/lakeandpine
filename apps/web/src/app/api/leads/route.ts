import { NextResponse } from "next/server";
import { z } from "zod";

import { createLead } from "@/lib/data";
import { sendOpsNotification } from "@/lib/email";
import { requestIntakeEnabled } from "@/lib/env";
import { getRuntimeSmokeDisposition } from "@/lib/runtime-smoke-request";

const leadSchema = z.object({
  fullName: z.string().min(1).max(200),
  zip: z.string().min(3).max(12),
  serviceId: z.enum(["essential", "deep", "move", "rental", "office", "addons"]).optional(),
  preferredDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  email: z.string().email().optional(),
  phone: z.string().max(30).optional(),
});

export async function POST(request: Request) {
  const smokeDisposition = getRuntimeSmokeDisposition(request.headers);
  if (smokeDisposition === "rejected") {
    return NextResponse.json({ error: "Invalid runtime smoke authorization" }, { status: 403 });
  }
  if (!requestIntakeEnabled && smokeDisposition !== "authorized") {
    return NextResponse.json(
      { error: "Lead intake is disabled until customer-data collection is approved." },
      { status: 503 },
    );
  }

  const body = await request.json().catch(() => null);
  const parsed = leadSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid lead" }, { status: 400 });
  }
  const lead = await createLead(parsed.data);
  await sendOpsNotification(
    {
      kind: "lead",
      summary: `${parsed.data.fullName} · ${parsed.data.zip}`,
      detailLines: [
        `Service: ${parsed.data.serviceId ?? "unspecified"}`,
        `Preferred date: ${parsed.data.preferredDate ?? "unspecified"}`,
        `Lead: ${lead.id}`,
      ],
    },
    { suppress: smokeDisposition === "authorized" },
  );
  return NextResponse.json({ id: lead.id });
}
