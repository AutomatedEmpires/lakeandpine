"use client";

import { useState, type ReactNode } from "react";

type TransitionFormProps = {
  action: (formData: FormData) => Promise<void>;
  teamId: string;
  caseId: string;
  from: string;
  nextStates: string[];
  reference: string;
};

export function ServiceCaseTransitionForm({
  action,
  teamId,
  caseId,
  from,
  nextStates,
  reference,
}: TransitionFormProps) {
  const [to, setTo] = useState("");
  const requiresResolution = to === "resolved" || to === "closed";
  return (
    <form action={action} className="inline-ops-form">
      <input type="hidden" name="teamId" value={teamId} />
      <input type="hidden" name="caseId" value={caseId} />
      <input type="hidden" name="from" value={from} />
      <select
        name="to"
        required
        value={to}
        onChange={(event) => setTo(event.target.value)}
        aria-label={`Next state for ${reference}`}
      >
        <option value="" disabled>Next case state</option>
        {nextStates.map((next) => (
          <option value={next} key={next}>{next.replaceAll("_", " ")}</option>
        ))}
      </select>
      <input
        name="resolutionSummary"
        maxLength={2000}
        required={requiresResolution}
        placeholder={
          requiresResolution
            ? "Required customer-visible outcome"
            : "Customer-visible outcome when resolving or closing"
        }
        aria-label={`Resolution summary for ${reference}`}
      />
      <button className="btn btn-soft">Update case</button>
    </form>
  );
}

export function ConfirmSubmitButton({
  children,
  message,
}: {
  children: ReactNode;
  message: string;
}) {
  return (
    <button
      className="btn btn-soft"
      type="submit"
      onClick={(event) => {
        if (!window.confirm(message)) event.preventDefault();
      }}
    >
      {children}
    </button>
  );
}
