"use client";

import Link from "next/link";
import { useSyncExternalStore } from "react";

const STORAGE_KEY = "lakepine_privacy_choice";
const PRIVACY_EVENT = "lakepine:privacy-choice";

function subscribe(onChange: () => void) {
  window.addEventListener("storage", onChange);
  window.addEventListener(PRIVACY_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(PRIVACY_EVENT, onChange);
  };
}

function privacyChoiceExists() {
  try {
    return Boolean(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return false;
  }
}

export function PrivacyPreferences() {
  const choiceExists = useSyncExternalStore(subscribe, privacyChoiceExists, () => true);

  function choose(value: "essential" | "analytics") {
    try {
      window.localStorage.setItem(STORAGE_KEY, value);
    } catch {}
    window.dispatchEvent(new Event(PRIVACY_EVENT));
    if (value === "analytics") {
      window.dispatchEvent(new Event("lakepine:analytics-consent"));
    }
  }

  if (choiceExists) return null;

  return (
    <aside className="privacy-preferences" aria-label="Privacy choices">
      <div>
        <strong>Your visit, your choice.</strong>
        <p>
          Essential site features work without analytics. Optional anonymous analytics only
          starts if you allow it. Read the <Link href="/privacy">privacy notice</Link>.
        </p>
      </div>
      <div className="privacy-actions">
        <button className="btn btn-soft" type="button" onClick={() => choose("essential")}>
          Essential only
        </button>
        <button className="btn btn-primary" type="button" onClick={() => choose("analytics")}>
          Allow analytics
        </button>
      </div>
    </aside>
  );
}
