// The estimate engine. Exact anchors recovered from the prototype's quote studio:
// the estimate is a $99-floored sum of component adders on top of nothing —
// the service adder carries most of the weight. Values are DOLLARS.
// Estimates are STARTING ANCHORS, never final quotes — every consumer of this
// module must present them that way.

export const SIZE_BANDS = [
  { id: "under_1200", label: "Under 1,200 sq ft", adder: 0 },
  { id: "1200_2000", label: "1,200–2,000 sq ft", adder: 25 },
  { id: "2000_3000", label: "2,000–3,000 sq ft", adder: 62 },
  { id: "3000_plus", label: "3,000+ sq ft", adder: 110 },
] as const;

export const ESTIMATE_SERVICES = [
  { id: "essential", label: "Essential Home Reset", adder: 114 },
  { id: "deep", label: "Pine & Polish Deep Clean", adder: 274 },
  { id: "move", label: "Move In / Out Detail", adder: 344 },
  { id: "rental", label: "Lakehouse Turnover", adder: 100 },
] as const;

export const BEDROOM_BANDS = [
  { id: "1_2", label: "1–2", adder: 0 },
  { id: "3", label: "3", adder: 12 },
  { id: "4", label: "4", adder: 26 },
  { id: "5_plus", label: "5+", adder: 42 },
] as const;

export const BATHROOM_BANDS = [
  { id: "1", label: "1", adder: 0 },
  { id: "2", label: "2", adder: 18 },
  { id: "3", label: "3", adder: 36 },
  { id: "4_plus", label: "4+", adder: 56 },
] as const;

export const FREQUENCIES = [
  { id: "weekly", label: "Weekly", adder: -30 },
  { id: "biweekly", label: "Bi-weekly", adder: -5 },
  { id: "monthly", label: "Monthly", adder: 18 },
  { id: "onetime", label: "One-time", adder: 38 },
] as const;

export const PET_BANDS = [
  { id: "none", label: "No pets", adder: 0 },
  { id: "one", label: "1 pet", adder: 10 },
  { id: "two_plus", label: "2+ pets", adder: 24 },
] as const;

// Priced add-ons fold into the anchor; quoted ones (windows, organization) never do.
export const PRICED_ADDONS: Record<string, number> = {
  fridge: 25,
  oven: 25,
  laundry: 25,
};

export const ESTIMATE_FLOOR = 99;

export type QuoteInputs = {
  sizeBand: (typeof SIZE_BANDS)[number]["id"];
  serviceId: (typeof ESTIMATE_SERVICES)[number]["id"];
  bedrooms: (typeof BEDROOM_BANDS)[number]["id"];
  bathrooms: (typeof BATHROOM_BANDS)[number]["id"];
  frequency: (typeof FREQUENCIES)[number]["id"];
  pets: (typeof PET_BANDS)[number]["id"];
  addonIds?: string[];
};

function adderOf<T extends readonly { id: string; adder: number }[]>(
  bands: T,
  id: string,
): number {
  const band = bands.find((b) => b.id === id);
  if (!band) throw new Error(`Unknown estimate input: ${id}`);
  return band.adder;
}

export function calculateEstimate(inputs: QuoteInputs): {
  dollars: number;
  cents: number;
  serviceLabel: string;
  frequencyLabel: string;
} {
  const base =
    adderOf(SIZE_BANDS, inputs.sizeBand) +
    adderOf(ESTIMATE_SERVICES, inputs.serviceId) +
    adderOf(BEDROOM_BANDS, inputs.bedrooms) +
    adderOf(BATHROOM_BANDS, inputs.bathrooms) +
    adderOf(FREQUENCIES, inputs.frequency) +
    adderOf(PET_BANDS, inputs.pets);
  const addons = (inputs.addonIds ?? []).reduce(
    (sum, id) => sum + (PRICED_ADDONS[id] ?? 0),
    0,
  );
  const dollars = Math.max(ESTIMATE_FLOOR, base) + addons;
  return {
    dollars,
    cents: dollars * 100,
    serviceLabel: ESTIMATE_SERVICES.find((s) => s.id === inputs.serviceId)!.label,
    frequencyLabel: FREQUENCIES.find((f) => f.id === inputs.frequency)!.label,
  };
}

export function formatDollars(cents: number): string {
  return `$${Math.round(cents / 100)}`;
}
