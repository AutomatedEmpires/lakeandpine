"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import { capture } from "@/lib/analytics-client";
import {
  BATHROOM_BANDS,
  BEDROOM_BANDS,
  calculateEstimate,
  ESTIMATE_SERVICES,
  FREQUENCIES,
  PET_BANDS,
  SIZE_BANDS,
  type QuoteInputs,
} from "@/lib/pricing";

const DEFAULTS: QuoteInputs = {
  sizeBand: "1200_2000",
  serviceId: "essential",
  bedrooms: "3",
  bathrooms: "2",
  frequency: "biweekly",
  pets: "one",
};

export function EstimateStudio() {
  const [inputs, setInputs] = useState<QuoteInputs>(DEFAULTS);
  const [priorities, setPriorities] = useState("");

  const estimate = useMemo(() => calculateEstimate(inputs), [inputs]);

  function set<K extends keyof QuoteInputs>(key: K, value: QuoteInputs[K]) {
    setInputs((prev) => ({ ...prev, [key]: value }));
    capture("quote_calculated", { key, value });
  }

  const selectField = <K extends keyof QuoteInputs>(
    label: string,
    key: K,
    bands: readonly { id: string; label: string }[],
  ) => (
    <div className="field">
      <label htmlFor={`quote-${key}`}>{label}</label>
      <select
        id={`quote-${key}`}
        value={inputs[key] as string}
        onChange={(e) => set(key, e.target.value as QuoteInputs[K])}
      >
        {bands.map((band) => (
          <option key={band.id} value={band.id}>
            {band.label}
          </option>
        ))}
      </select>
    </div>
  );

  return (
    <div className="quote-lab">
      <div className="quote-panel card">
        <div className="form-grid">
          {selectField("Home size", "sizeBand", SIZE_BANDS)}
          {selectField("Service", "serviceId", ESTIMATE_SERVICES)}
          {selectField("Bedrooms", "bedrooms", BEDROOM_BANDS)}
          {selectField("Bathrooms", "bathrooms", BATHROOM_BANDS)}
          {selectField("Frequency", "frequency", FREQUENCIES)}
          {selectField("Pets", "pets", PET_BANDS)}
          <div className="field full">
            <label htmlFor="quote-priorities">Priorities</label>
            <textarea
              id="quote-priorities"
              value={priorities}
              onChange={(e) => setPriorities(e.target.value)}
              placeholder="Example: focus on bathrooms, kitchen floors, glass, rental turnover checklist, or unscented products."
            />
          </div>
        </div>
      </div>
      <div className="estimate-result">
        <div>
          <span className="eyebrow">Estimated start</span>
          <div className="big">${estimate.dollars}</div>
          <p>
            {estimate.frequencyLabel} {estimate.serviceLabel} starting point. Final quote
            depends on condition and custom requests.
          </p>
        </div>
        <div>
          <ul className="checks">
            <li>Computed in your browser</li>
            <li>Nothing entered here is stored</li>
            <li>Final scope requires human review</li>
          </ul>
          <Link
            className="btn btn-soft"
            style={{ width: "100%" }}
            href={`/book?service=${inputs.serviceId}&frequency=${inputs.frequency}`}
          >
            Continue to service planning
          </Link>
        </div>
      </div>
    </div>
  );
}
