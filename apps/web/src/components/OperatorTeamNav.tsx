import Link from "next/link";

import type { OperationsDashboard } from "@/lib/team-operations-data";

const SECTIONS = [
  ["network", "Network"],
  ["schedule", "Schedule"],
  ["inventory", "Inventory"],
  ["workforce", "Workforce"],
  ["time", "Time + performance"],
  ["recovery", "Recovery"],
  ["compensation", "Pay + bonuses"],
] as const;

export function OperatorTeamNav({
  dashboard,
  current,
}: {
  dashboard: OperationsDashboard;
  current: (typeof SECTIONS)[number][0];
}) {
  const teamQuery = dashboard.selectedTeamId
    ? `?team=${dashboard.selectedTeamId}`
    : "";
  return (
    <>
      <nav className="operations-tabs" aria-label="Team operations">
        {SECTIONS.map(([id, label]) => (
          <Link
            aria-current={id === current ? "page" : undefined}
            className={id === current ? "active" : undefined}
            href={`/operator/${id}${teamQuery}`}
            key={id}
          >
            {label}
          </Link>
        ))}
      </nav>
      {dashboard.teams.length > 0 && (
        <div className="team-scope-strip" aria-label="Active team scope">
          <span>Team scope</span>
          <div>
            {dashboard.teams.map((team) => (
              <Link
                aria-current={team.id === dashboard.selectedTeamId ? "page" : undefined}
                className={team.id === dashboard.selectedTeamId ? "active" : ""}
                href={`/operator/${current}?team=${team.id}`}
                key={team.id}
              >
                {team.name}
                <small className={`attention-dot ${team.attention}`} aria-label={`${team.attention} attention`} />
              </Link>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
