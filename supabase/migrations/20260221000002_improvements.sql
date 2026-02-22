-- Fix 1: track whether a saved resolution actually worked
alter table incidents add column if not exists worked boolean not null default true;

-- Fix 10: persist incident investigation start times across server restarts
create table if not exists incident_investigations (
  service_name text primary key,
  started_at   timestamptz not null default now()
);
alter table incident_investigations enable row level security;

-- Fix 11: explicit RLS policies — block all non-service-role access
-- (service_role bypasses RLS, so the MCP server is unaffected)
do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'services'                  and policyname = 'deny_non_service_role') then
    create policy "deny_non_service_role" on services                  for all using (false);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'incidents'                 and policyname = 'deny_non_service_role') then
    create policy "deny_non_service_role" on incidents                 for all using (false);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'deployments'               and policyname = 'deny_non_service_role') then
    create policy "deny_non_service_role" on deployments               for all using (false);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'runbooks'                  and policyname = 'deny_non_service_role') then
    create policy "deny_non_service_role" on runbooks                  for all using (false);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'incident_investigations'   and policyname = 'deny_non_service_role') then
    create policy "deny_non_service_role" on incident_investigations   for all using (false);
  end if;
end $$;
