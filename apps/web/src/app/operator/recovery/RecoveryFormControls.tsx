"use client";

import { useState, type ReactNode } from "react";

import {
  confirmationPreventsSubmission,
  resolutionSummaryFieldState,
} from "./recovery-form-state";

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
  const summaryField = resolutionSummaryFieldState(to);
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
        required={summaryField.required}
        placeholder={summaryField.placeholder}
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
        if (
          confirmationPreventsSubmission(message, (prompt) =>
            window.confirm(prompt),
          )
        ) {
          event.preventDefault();
        }
      }}
    >
      {children}
    </button>
  );
}
