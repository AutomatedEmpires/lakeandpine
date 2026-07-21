import { z } from "zod";

import { PREMIUM_PROGRAMS } from "./premium-request.ts";

export const schedulingScopeSchema = z.object({
  program: z.enum(PREMIUM_PROGRAMS),
  postalCode: z.string().trim().min(3).max(12),
  context: z.string().trim().min(1).max(80),
  sizeBand: z.enum(["compact", "standard", "large", "exceptional"]),
  condition: z.enum(["maintained", "detailed", "project"]),
  cadence: z.enum([
    "project",
    "weekly",
    "biweekly",
    "monthly",
    "seasonal",
    "custom",
  ]),
  zoneCount: z.number().int().min(1).max(80),
  siteReady: z.boolean(),
  accessComplex: z.boolean(),
  finishSensitive: z.boolean(),
  finishRestrictionsAcknowledged: z.boolean(),
});

export const availabilityRequestSchema = z.object({
  scope: schedulingScopeSchema,
});

export const reservationRequestSchema = availabilityRequestSchema.extend({
  slotId: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  idempotencyKey: z.string().uuid(),
  companyWebsite: z.string().max(200).optional().default(""),
  contact: z.object({
    name: z.string().trim().min(2).max(200),
    email: z.string().trim().email().max(320),
    phone: z.string().trim().min(7).max(30),
  }),
  acknowledgements: z.object({
    privacyConsent: z.literal(true),
    termsConsent: z.literal(true),
    siteReady: z.literal(true),
  }),
});

export const guestManagementTokenSchema = z
  .string()
  .regex(/^lp_manage_[A-Za-z0-9_-]{43}$/);

export type SchedulingScopeInput = z.infer<typeof schedulingScopeSchema>;
export type ReservationRequestInput = z.infer<typeof reservationRequestSchema>;

export type PublicSchedulingSlot = {
  id: string;
  date: string;
  start: string;
  end: string;
  arrivalWindow: string;
  timeZone: string;
  state: "available_to_hold";
  schedulingPath: "direct" | "conditional_hold";
  holdMinutes: number;
  conditionLabel: string | null;
};

export type PublicAvailabilityResponse = {
  classification: {
    path:
      | "direct"
      | "conditional_hold"
      | "consultation"
      | "insufficient_data"
      | "unsupported_territory"
      | "no_capacity";
    publicReason: string;
    conditionLabel: string | null;
  };
  slots: PublicSchedulingSlot[];
};
