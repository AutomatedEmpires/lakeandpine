export const JOB_STATUSES = [
  "requested",
  "reviewing",
  "ready",
  "confirmed",
  "scheduled",
  "in_progress",
  "completed",
  "follow_up",
  "canceled",
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

export type PropertyProfile = {
  propertyType: "house" | "apartment" | "townhome" | "rental";
  sizeBand: "under_1200" | "1200_2000" | "2000_3000" | "3000_plus";
  bedrooms: "1_2" | "3" | "4" | "5_plus";
  bathrooms: "1" | "2" | "3" | "4_plus";
  floors: "1" | "2" | "3_plus";
  condition: "maintained" | "needs_detail";
};

export type RoomPlan = {
  id: string;
  label: string;
  selected: boolean;
  note?: string;
};

export type PlanningInput = {
  serviceId: "essential" | "deep" | "move" | "rental";
  property: PropertyProfile;
  rooms: RoomPlan[];
  preferences: string[];
  petNotes?: string;
  accessMethod?: string;
  accessNotes?: string;
  specialInstructions?: string;
  addonIds: string[];
};

export type PlanningDirection = {
  score: number;
  effort: "standard" | "extended" | "operator review";
  summary: string;
  checklist: { roomLabel: string | null; label: string }[];
};

const BASE_CHECKLIST = [
  "Confirm agreed scope before starting",
  "Dust reachable surfaces and fixtures",
  "Vacuum and mop applicable floors",
  "Reset waste bins and complete final walkthrough",
];

const ROOM_TASKS: Record<string, string[]> = {
  kitchen: ["Clean counters and backsplash", "Clean sink and appliance exteriors", "Finish kitchen floors"],
  primary_bedroom: ["Dust surfaces", "Vacuum or mop floor", "Reset requested linens"],
  bedroom: ["Dust surfaces", "Vacuum or mop floor"],
  bathroom: ["Clean sink, mirror, toilet, tub or shower", "Finish bathroom floor"],
  living_room: ["Dust surfaces and reachable fixtures", "Vacuum upholstery as scoped", "Finish floors"],
  office: ["Dust open surfaces without moving papers", "Vacuum or mop floor"],
  mudroom: ["Wipe reachable surfaces", "Finish entry floor"],
  laundry: ["Wipe appliance exteriors", "Finish laundry floor"],
};

const STATUS_TRANSITIONS: Record<JobStatus, readonly JobStatus[]> = {
  requested: ["reviewing", "canceled"],
  reviewing: ["ready", "requested", "canceled"],
  ready: ["confirmed", "reviewing", "canceled"],
  confirmed: ["scheduled", "reviewing", "canceled"],
  scheduled: ["in_progress", "canceled"],
  in_progress: ["completed", "scheduled"],
  completed: ["follow_up"],
  follow_up: [],
  canceled: [],
};

export const COMMUNICATION_PLAN = [
  { stage: "Request received", owner: "System", channel: "Email when enabled", timing: "Immediately" },
  { stage: "Plan reviewed", owner: "Operator", channel: "Manual call, text, or email", timing: "After scope review" },
  { stage: "Visit confirmed", owner: "Operator", channel: "Manual confirmation", timing: "Only after capacity is checked" },
  { stage: "Arrival update", owner: "Operator", channel: "Manual text", timing: "Day of service" },
  { stage: "Service check-in", owner: "Operator", channel: "Manual follow-up", timing: "After completion" },
  { stage: "Review request", owner: "Operator", channel: "Manual follow-up", timing: "After the check-in" },
] as const;

export function canTransitionJob(from: JobStatus, to: JobStatus): boolean {
  return STATUS_TRANSITIONS[from].includes(to);
}

export function buildPlanningDirection(input: PlanningInput): PlanningDirection {
  const selectedRooms = input.rooms.filter((room) => room.selected);
  let score = 20;
  if (input.serviceId === "deep") score += 22;
  if (input.serviceId === "move") score += 28;
  if (input.serviceId === "rental") score += 16;
  if (input.property.sizeBand === "2000_3000") score += 12;
  if (input.property.sizeBand === "3000_plus") score += 22;
  if (input.property.floors === "2") score += 5;
  if (input.property.floors === "3_plus") score += 10;
  if (input.property.condition === "needs_detail") score += 18;
  score += Math.max(0, selectedRooms.length - 4) * 2;
  score += input.addonIds.length * 3;
  if (input.petNotes?.trim()) score += 4;
  if (input.accessNotes?.trim()) score += 2;
  if (input.specialInstructions?.trim()) score += 4;
  score = Math.min(100, score);

  const effort = score >= 70 ? "operator review" : score >= 45 ? "extended" : "standard";
  const focusRooms = selectedRooms.slice(0, 3).map((room) => room.label).join(", ");
  const summary = `${effort[0].toUpperCase()}${effort.slice(1)} plan · ${selectedRooms.length} rooms${
    focusRooms ? ` · focus: ${focusRooms}` : ""
  }`;

  const checklist = [
    ...BASE_CHECKLIST.map((label) => ({ roomLabel: null, label })),
    ...selectedRooms.flatMap((room) => {
      const tasks = ROOM_TASKS[room.id] ?? ["Complete agreed room scope"];
      return [
        ...tasks.map((label) => ({ roomLabel: room.label, label })),
        ...(room.note?.trim()
          ? [{ roomLabel: room.label, label: `Review room note: ${room.note.trim()}` }]
          : []),
      ];
    }),
    ...input.preferences.map((preference) => ({ roomLabel: null, label: `Preference: ${preference}` })),
  ];

  return { score, effort, summary, checklist };
}
