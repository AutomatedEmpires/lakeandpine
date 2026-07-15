import { connect } from "./_db.mjs";

if (process.env.LAKEANDPINE_FIELD_ROLLOUT_CHECK !== "1") {
  throw new Error(
    "Field rollout readiness check is disabled. Select the intended database and set LAKEANDPINE_FIELD_ROLLOUT_CHECK=1.",
  );
}

const sql = connect();

try {
  const [target] = await sql`
    select current_database() as database_name,
      current_user as database_user,
      coalesce(inet_server_addr()::text, 'local-socket') as server_address`;
  console.log(
    `Field rollout readiness target: ${target.database_name} @ ${target.server_address} as ${target.database_user}`,
  );

  const blockers = await sql`
    select schedule.id as schedule_id, schedule.status,
      schedule.start_at::text, team.name as team_name,
      coalesce(assessment.assessment_status, 'missing') as route_status,
      exists (
        select 1
        from schedule_proposals proposal
        where proposal.job_schedule_id = schedule.id
          and proposal.status = 'approved'
          and (
            (
              proposal.service_case_id is not null
              and proposal.proposed_start_at = schedule.start_at
              and proposal.proposed_end_at = schedule.end_at
            )
            or (
              proposal.service_case_id is null
              and schedule.start_at >= proposal.arrival_window_start
              and (
                schedule.start_at < proposal.arrival_window_end
                or (
                  schedule.start_at = proposal.arrival_window_end
                  and (schedule.start_at at time zone team.timezone)::time
                    = team.latest_arrival_time
                )
              )
            )
          )
      ) as has_customer_window_evidence,
      exists (
        select 1
        from private.legacy_field_execution_continuity legacy
        where legacy.job_schedule_id = schedule.id
          and legacy.original_start_at = schedule.start_at
          and legacy.original_end_at = schedule.end_at
          and schedule.status in ('en_route', 'in_progress', 'quality_review')
      ) as has_legacy_execution_continuity
    from job_schedules schedule
    join team_job_allocations allocation on allocation.job_schedule_id = schedule.id
    join cleaning_teams team
      on team.organization_id = allocation.organization_id
     and team.id = allocation.team_id
    left join service_location_assessments assessment
      on assessment.booking_id = schedule.booking_id
    where schedule.status in ('confirmed', 'en_route', 'in_progress', 'quality_review')
      and (
        assessment.assessment_status is null
        or assessment.assessment_status not in ('inside_standard_radius', 'approved_exception')
        or (
          not exists (
            select 1
            from schedule_proposals proposal
            where proposal.job_schedule_id = schedule.id
              and proposal.status = 'approved'
              and (
                (
                  proposal.service_case_id is not null
                  and proposal.proposed_start_at = schedule.start_at
                  and proposal.proposed_end_at = schedule.end_at
                )
                or (
                  proposal.service_case_id is null
                  and schedule.start_at >= proposal.arrival_window_start
                  and (
                    schedule.start_at < proposal.arrival_window_end
                    or (
                      schedule.start_at = proposal.arrival_window_end
                      and (schedule.start_at at time zone team.timezone)::time
                        = team.latest_arrival_time
                    )
                  )
                )
              )
          )
          and not exists (
            select 1
            from private.legacy_field_execution_continuity legacy
            where legacy.job_schedule_id = schedule.id
              and legacy.original_start_at = schedule.start_at
              and legacy.original_end_at = schedule.end_at
              and schedule.status in ('en_route', 'in_progress', 'quality_review')
          )
        )
      )
    order by schedule.start_at, schedule.id
    limit 100`;

  if (blockers.length) {
    console.error("Field rollout is BLOCKED. Resolve these active schedules:");
    for (const blocker of blockers) {
      console.error(JSON.stringify(blocker));
    }
    throw new Error(
      `${blockers.length} active schedule(s) lack approved route or window evidence`,
    );
  }

  console.log(
    "Field rollout readiness PASS: every active allocated schedule has approved route and window evidence.",
  );
} finally {
  await sql.end({ timeout: 5 });
}
