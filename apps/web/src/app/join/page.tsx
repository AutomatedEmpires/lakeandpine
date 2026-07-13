import type { Metadata } from "next";

import { CleanerApplicationForm } from "@/components/CleanerApplicationForm";
import { cleanerApplicationsEnabled } from "@/lib/env";

export const metadata: Metadata = {
  title: "Join the Team | Lake & Pine",
  description: "Introduce yourself for future Lake & Pine estate, construction, marine-interior, and select commercial cleaning work.",
};

export default function JoinPage() {
  return (
    <main className="route-page">
      <section className="container page-hero">
        <div className="page-panel">
          <span className="eyebrow">Work with Lake & Pine</span>
          <h1>Careful work for exceptional properties.</h1>
          <p className="lead">Lake & Pine is building a team around preparation, finish awareness, reliable communication, and accountable closeout—not rushed turnover volume. Introduce yourself without sending sensitive hiring documents.</p>
        </div>
      </section>
      <section className="container section" style={{ paddingTop: 0 }}>
        <CleanerApplicationForm applicationsEnabled={cleanerApplicationsEnabled} />
      </section>
    </main>
  );
}

