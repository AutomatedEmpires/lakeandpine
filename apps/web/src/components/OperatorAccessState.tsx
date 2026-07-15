import Link from "next/link";

import type { OperatorIdentity } from "@/lib/auth";
import type { OperationsDashboard } from "@/lib/team-operations-data";

import { bootstrapOwnerAction } from "@/app/operator/team-operations-actions";

export function OperatorDenied({ identity }: { identity: OperatorIdentity }) {
  return (
    <div className="route-page">
      <section className="container page-hero">
        <div className="page-panel operator-locked">
          <span className="eyebrow">Private national operations</span>
          <h1>{identity.state === "denied" ? "This account is not an operator." : "Operator sign-in required."}</h1>
          <p className="lead">Team, workforce, inventory, time, and compensation records stay behind staff authorization.</p>
          <Link className="btn btn-primary" href="/sign-in?redirect_url=/operator/network">Sign in</Link>
        </div>
      </section>
    </div>
  );
}
export function OwnerBootstrap({ dashboard }: { dashboard: OperationsDashboard }) {
  return (
    <div className="route-page operator-page">
      <section className="container page-hero">
        <div className="page-panel operator-locked">
          <span className="eyebrow">One-time national control setup</span>
          <h1>Establish the Lake & Pine owner role.</h1>
          <p className="lead">
            This staff identity is authenticated but has no workforce role yet. The first verified staff operator can claim the national owner role; subsequent access is assigned by that owner.
          </p>
          <form action={bootstrapOwnerAction}>
            <button className="btn btn-primary" disabled={dashboard.access.devOnly}>
              Establish national owner control
            </button>
          </form>
          {dashboard.access.devOnly && <p className="copy">Owner bootstrap is disabled in preview mode.</p>}
        </div>
      </section>
    </div>
  );
}
